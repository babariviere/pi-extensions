/** Journal-backed run history for subagent batches. Task bodies and launch credentials never enter this journal. */

import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSession, defineDoc, type JsonObject, type Storage } from "@earendil-works/pi-durable";

import {
	type AgentBatchRegistration,
	type AgentBatchSnapshot,
	type AgentBatchState,
	type AgentCompletionEvent,
	type AgentCompletionSink,
	type AgentResult,
	type AgentWaitOutcome,
	SETTLED_HISTORY,
} from "./agent-run-book.ts";
import type { AgentRuns } from "./agent-runs.ts";

const ANNOUNCE_DELAY_MS = 150;

interface StoredBatch extends JsonObject {
	runId: string;
	agents: string[];
	startedAt: number;
	state: AgentBatchState;
	detached: boolean;
	claimed: boolean;
	announced: boolean;
	results: JsonValue[] | null;
}

interface DurableRunBookState extends JsonObject {
	records: StoredBatch[];
}

const RunBookDoc = defineDoc<DurableRunBookState>({
	kind: "pi.subagents.durable-run-book",
	version: 1,
	scope: "session",
	initial: () => ({ records: [] }),
});

interface RuntimeBatch {
	admission: Promise<void>;
	admitted: boolean;
	completion?: AgentResult[];
	cancel?: () => void;
	onDetach?: () => void;
	waiters: number;
	detached: boolean;
	cancelCalled: boolean;
	finished: Promise<void>;
	finish(): void;
	fail(error: Error): void;
	cancelled: Promise<void>;
	wakeCancelled(): void;
}

export interface DurableAgentRunBookOptions {
	onError?: (error: Error) => void;
	announceDelayMs?: number;
}

/**
 * Persisted counterpart to AgentRunBook. Each lifecycle boundary commits before
 * the corresponding child, waiter, or completion sink can observe it.
 */
export class DurableRunBook implements AgentRuns {
	readonly #session;
	readonly #onError: ((error: Error) => void) | undefined;
	readonly #announceDelayMs: number;
	#records = new Map<string, StoredBatch>();
	readonly #runtime = new Map<string, RuntimeBatch>();
	readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
	#sink: AgentCompletionSink | undefined;
	#canAnnounce: () => boolean = () => true;
	#observerVersion = 0;
	#releaseObservers: () => void = () => {};
	#observersDetached = new Promise<void>((resolve) => {
		this.#releaseObservers = resolve;
	});
	#tail: Promise<void> = Promise.resolve();
	#failure: Error | undefined;
	#rejectFailure: (error: Error) => void = () => {};
	readonly #failed = new Promise<never>((_resolve, reject) => {
		this.#rejectFailure = reject;
	});
	#closing = false;
	#closed = false;
	#closePromise: Promise<void> | undefined;

	private constructor(storage: Storage, options: DurableAgentRunBookOptions) {
		this.#session = createSession(storage);
		this.#onError = options.onError;
		this.#announceDelayMs = options.announceDelayMs ?? ANNOUNCE_DELAY_MS;
		// The rejection is consumed by waiters, but a failure may happen before any waiter exists.
		void this.#failed.catch(() => {});
	}

	/** Open the journal and convert records left running by a previous process into explicit failures. */
	static async open(storage: Storage, options: DurableAgentRunBookOptions = {}): Promise<DurableRunBook> {
		const book = new DurableRunBook(storage, options);
		try {
			let snapshot = await book.#session.snapshot(RunBookDoc, BACKGROUND_CONTEXT);
			if (!snapshot) {
				await book.#session.commit(async (tx) => {
					await tx.doc(RunBookDoc);
				}, BACKGROUND_CONTEXT);
				snapshot = await book.#session.snapshot(RunBookDoc, BACKGROUND_CONTEXT);
			}
			if (!snapshot) throw new Error("Durable run book journal could not be initialized");
			book.#records = new Map(snapshot.records.map((record) => [record.runId, copyStored(record)]));

			const recovered = new Map(book.#records);
			let changed = false;
			for (const [runId, record] of recovered) {
				if (record.state === "running") {
					recovered.set(runId, {
						...record,
						state: "settled",
						detached: true,
						results: asStoredResults(interruptedResults(record)),
					});
					changed = true;
				} else if (record.state === "cancelled" && record.results === null) {
					recovered.set(runId, {
						...record,
						detached: true,
						claimed: true,
						results: asStoredResults(cancelledResults(record)),
					});
					changed = true;
				}
			}
			if (changed) await book.#enqueue(() => book.#persistLocked(recovered));
			return book;
		} catch (error) {
			try {
				await book.#session.close(BACKGROUND_CONTEXT);
			} catch {
				// Preserve the opening error.
			}
			throw error;
		}
	}

	setAnnounceWhen(ready: () => boolean): void {
		this.#canAnnounce = ready;
	}

	setSink(sink: AgentCompletionSink | undefined): void {
		this.#sink = sink;
		if (sink) this.#background(this.flushCompletions());
	}

	async flushCompletions(): Promise<void> {
		for (const record of [...this.#records.values()]) await this.#announce(record.runId);
	}

	async register(registration: AgentBatchRegistration): Promise<void> {
		this.#assertHealthy();
		if (this.#closing) throw new Error("Durable run book is closing");
		if (this.#records.has(registration.runId) || this.#runtime.has(registration.runId)) {
			throw new Error(`Subagent run already registered: ${registration.runId}`);
		}

		let finish!: () => void;
		let fail!: (error: Error) => void;
		let wakeCancelled!: () => void;
		const finished = new Promise<void>((resolve, reject) => {
			finish = resolve;
			fail = reject;
		});
		const cancelled = new Promise<void>((resolve) => {
			wakeCancelled = resolve;
		});
		void finished.catch(() => {});
		const runtime: RuntimeBatch = {
			admission: Promise.resolve(),
			admitted: false,
			cancel: registration.cancel,
			...(registration.onDetach ? { onDetach: registration.onDetach } : {}),
			waiters: 0,
			detached: false,
			cancelCalled: false,
			finished,
			finish,
			fail,
			cancelled,
			wakeCancelled,
		};
		this.#runtime.set(registration.runId, runtime);

		// Attach both handlers now: a launcher may finish or reject before its admission commit.
		void Promise.resolve(registration.promise)
			.then(
				(results) => this.#receivedResults(registration.runId, runtime, results),
				(error: unknown) => this.#receivedResults(registration.runId, runtime, failureResult(registration, error)),
			)
			.catch((error: unknown) => this.#report(error));

		const record: StoredBatch = {
			runId: registration.runId,
			agents: [...registration.agents],
			startedAt: Date.now(),
			state: "running",
			detached: false,
			claimed: false,
			announced: false,
			results: null,
		};
		const admission = this.#enqueue(async () => {
			const next = new Map(this.#records);
			next.set(record.runId, record);
			await this.#persistLocked(prune(next, this.#runtime));
		});
		runtime.admission = admission;
		try {
			await admission;
			runtime.admitted = true;
			if (runtime.completion) await this.#persistResults(registration.runId, runtime, runtime.completion);
		} catch (error) {
			this.#invokeDetach(runtime);
			this.#kill(runtime);
			throw error;
		}
	}

	async wait(runId: string, waitMs: number): Promise<AgentWaitOutcome> {
		this.#assertHealthy();
		const observerVersion = this.#observerVersion;
		const detached = this.#observersDetached;
		const pending = this.#runtime.get(runId);
		if (pending) await pending.admission;
		this.#assertHealthy();
		let record = this.#records.get(runId);
		if (!record) throw new Error(`Unknown subagent run: ${runId}`);
		if (observerVersion !== this.#observerVersion) return detachedOutcome(record);
		if (record.results !== null) return this.#claim(runId, observerVersion);
		if (record.state === "cancelled") return { state: "cancelled", snapshot: snapshotOf(record) };

		const runtime = this.#runtime.get(runId);
		if (!runtime) throw new Error(`Unknown subagent run: ${runId}`);
		if (waitMs <= 0) {
			await this.#detach(runId, runtime);
			record = this.#records.get(runId) ?? record;
			if (observerVersion !== this.#observerVersion) return detachedOutcome(record);
			if (record.results !== null) return this.#claim(runId, observerVersion);
			return { state: record.state, snapshot: snapshotOf(record) };
		}

		runtime.waiters++;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const expired = new Promise<"expired">((resolve) => {
			timer = setTimeout(() => resolve("expired"), waitMs);
		});
		try {
			await Promise.race([runtime.finished, runtime.cancelled, expired, detached, this.#failed]);
			this.#assertHealthy();
			record = this.#records.get(runId);
			if (!record) throw new Error(`Unknown subagent run: ${runId}`);
			if (observerVersion !== this.#observerVersion) return detachedOutcome(record);
			if (record.results !== null) return await this.#claim(runId, observerVersion);
			if (record.state === "cancelled") return { state: "cancelled", snapshot: snapshotOf(record) };
			await this.#detach(runId, runtime);
			record = this.#records.get(runId) ?? record;
			if (observerVersion !== this.#observerVersion) return detachedOutcome(record);
			if (record.results !== null) return await this.#claim(runId, observerVersion);
			return { state: record.state, snapshot: snapshotOf(record) };
		} finally {
			if (timer) clearTimeout(timer);
			runtime.waiters--;
			if (runtime.waiters === 0 && this.#records.get(runId)?.results != null) this.#runtime.delete(runId);
		}
	}

	list(): AgentBatchSnapshot[] {
		this.#assertHealthy();
		return [...this.#records.values()].map((record) => snapshotOf(record));
	}

	async cancel(runId?: string): Promise<string[]> {
		if (this.#failure || this.#closed) return [];
		const ids = runId ? [runId] : [...this.#records.keys(), ...this.#runtime.keys()];
		const cancelled: string[] = [];
		for (const id of [...new Set(ids)]) {
			const runtime = this.#runtime.get(id);
			if (runtime) {
				try {
					await runtime.admission;
				} catch {
					continue;
				}
			}
			try {
				const shouldKill = await this.#enqueue(async () => {
					const current = this.#records.get(id);
					if (!current) {
						if (runId) throw new Error(`Unknown subagent run: ${runId}`);
						return false;
					}
					if (current.state !== "running") return false;
					const next = new Map(this.#records);
					next.set(id, { ...current, state: "cancelled", claimed: true });
					await this.#persistLocked(next);
					return true;
				});
				if (!shouldKill) continue;
				cancelled.push(id);
				runtime?.wakeCancelled();
				if (runtime) this.#kill(runtime);
			} catch (error) {
				// #enqueue has already failed closed and cancelled all live children. Keep abort-hook callers safe.
				this.#report(error);
				if (runId && !this.#failure) throw error;
				break;
			}
		}
		return cancelled;
	}

	async drain(timeoutMs: number): Promise<boolean> {
		if (!this.#failure && !this.#closed) await this.cancel();
		const pending = [...this.#runtime.values()].map((runtime) => runtime.finished);
		if (pending.length === 0) return !this.#failure;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const expiry = new Promise<boolean>((resolve) => {
			timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
		});
		try {
			return await Promise.race([Promise.all(pending).then(() => true), this.#failed.then(() => false), expiry]);
		} catch {
			return false;
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	async suspend(): Promise<void> {
		this.#sink = undefined;
		this.#canAnnounce = () => false;
		this.#clearTimers();
		// Return handles to the obsolete runtime's waiters now. They must not
		// retain its tool context or claim results intended for the replacement.
		this.#observerVersion++;
		this.#releaseObservers();
		this.#observersDetached = new Promise<void>((resolve) => {
			this.#releaseObservers = resolve;
		});
		for (const runtime of this.#runtime.values()) this.#invokeDetach(runtime);
		const running = [...this.#records.values()].filter((record) => record.state === "running" && !record.detached);
		if (running.length > 0) {
			await this.#enqueue(async () => {
				const next = new Map(this.#records);
				for (const record of running) {
					const current = next.get(record.runId);
					if (current?.state === "running") next.set(record.runId, { ...current, detached: true });
				}
				await this.#persistLocked(next);
			});
		}
	}

	close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#closing = true;
		this.#sink = undefined;
		this.#canAnnounce = () => false;
		this.#clearTimers();
		for (const runtime of this.#runtime.values()) this.#invokeDetach(runtime);
		this.#closePromise = (async () => {
			try {
				if (!this.#failure) {
					await this.cancel();
					// The owner has already bounded its drain. Never join a runner
					// that ignores abort, or allow late writes after ownership release.
					await this.#enqueue(async () => {
						const next = new Map(this.#records);
						let changed = false;
						for (const [runId, record] of next) {
							if (record.state === "cancelled" && record.results === null) {
								next.set(runId, {
									...record,
									results: asStoredResults(
										cancelledResults(
											record,
											"Cancelled during session shutdown; child termination was not confirmed.",
										),
									),
								});
								changed = true;
							}
						}
						if (changed) await this.#persistLocked(next);
						this.#closed = true;
					});
				}
			} finally {
				await this.#tail;
				this.#closed = true;
				for (const runtime of this.#runtime.values()) runtime.finish();
				this.#runtime.clear();
				await this.#session.close(BACKGROUND_CONTEXT);
			}
		})();
		return this.#closePromise;
	}

	async #claim(runId: string, observerVersion: number): Promise<AgentWaitOutcome> {
		return this.#enqueue(async () => {
			const current = this.#records.get(runId);
			if (!current) throw new Error(`Unknown subagent run: ${runId}`);
			if (observerVersion !== this.#observerVersion) return detachedOutcome(current);
			if (current.results === null) return { state: current.state, snapshot: snapshotOf(current) };
			const next = new Map(this.#records);
			const record = { ...current, claimed: true };
			next.set(runId, record);
			await this.#persistLocked(prune(next, this.#runtime));
			this.#clearTimer(runId);
			return {
				state: record.state,
				snapshot: snapshotOf(record, true),
				results: copyResults(record.results),
			};
		});
	}

	async #detach(runId: string, runtime: RuntimeBatch): Promise<void> {
		if (runtime.detached) return;
		const current = this.#records.get(runId);
		if (!current || current.results !== null) return;
		await this.#enqueue(async () => {
			const record = this.#records.get(runId);
			if (!record || record.results !== null) return;
			const next = new Map(this.#records);
			next.set(runId, { ...record, detached: true });
			await this.#persistLocked(next);
			runtime.detached = true;
			this.#invokeDetach(runtime);
		});
	}

	async #receivedResults(runId: string, runtime: RuntimeBatch, results: AgentResult[]): Promise<void> {
		if (this.#closed || this.#failure || runtime.completion) return;
		runtime.completion = cloneResults(results);
		if (runtime.admitted) await this.#persistResults(runId, runtime, runtime.completion);
	}

	async #persistResults(runId: string, runtime: RuntimeBatch, results: AgentResult[]): Promise<void> {
		try {
			await this.#enqueue(async () => {
				const current = this.#records.get(runId);
				if (!current || current.results !== null) return;
				const next = new Map(this.#records);
				next.set(runId, {
					...current,
					state: current.state === "running" ? "settled" : current.state,
					results: asStoredResults(results),
				});
				await this.#persistLocked(prune(next, this.#runtime));
				this.#clearTimer(runId);
				runtime.finish();
				runtime.cancel = undefined;
				runtime.onDetach = undefined;
				if (runtime.waiters === 0) this.#runtime.delete(runId);
				this.#scheduleAnnouncement(runId);
			});
		} catch (error) {
			runtime.fail(asError(error));
			throw error;
		}
	}

	async #announce(runId: string): Promise<void> {
		await this.#enqueue(async () => {
			const record = this.#records.get(runId);
			const sink = this.#sink;
			if (
				!record ||
				record.results === null ||
				record.state !== "settled" ||
				record.claimed ||
				record.announced ||
				(this.#runtime.get(runId)?.waiters ?? 0) > 0 ||
				!sink ||
				this.#closing ||
				!this.#isReady()
			) {
				return;
			}
			const next = new Map(this.#records);
			next.set(runId, { ...record, claimed: true, announced: true });
			await this.#persistLocked(next);
			this.#clearTimer(runId);
			const committed = this.#records.get(runId);
			if (!committed?.results) return;
			// Suspension can replace observers while the receipt commit is in flight.
			// Never invoke an obsolete runtime's sink after that cutover.
			if (this.#sink !== sink || this.#closing || !this.#isReady()) return;
			const event: AgentCompletionEvent = {
				runId,
				agents: [...committed.agents],
				results: copyResults(committed.results),
				elapsedMs: Date.now() - committed.startedAt,
			};
			try {
				const maybePromise = sink(event) as unknown;
				if (maybePromise && typeof (maybePromise as PromiseLike<unknown>).then === "function") {
					void Promise.resolve(maybePromise).catch((error: unknown) => this.#report(error));
				}
			} catch (error) {
				this.#report(error);
			}
		});
	}

	#scheduleAnnouncement(runId: string): void {
		const record = this.#records.get(runId);
		if (!record || record.results === null || record.claimed || record.announced || this.#closing) return;
		this.#clearTimer(runId);
		const timer = setTimeout(() => {
			this.#timers.delete(runId);
			this.#background(this.#announce(runId));
		}, this.#announceDelayMs);
		timer.unref?.();
		this.#timers.set(runId, timer);
	}

	#enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.#tail.then(() => {
			this.#assertHealthy();
			return operation();
		});
		this.#tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	async #persistLocked(records: Map<string, StoredBatch>): Promise<void> {
		try {
			const saved = [...records.values()].map(copyStored);
			await this.#session.commit(async (tx) => {
				const document = await tx.doc(RunBookDoc);
				document.records = saved;
			}, BACKGROUND_CONTEXT);
			this.#records = records;
		} catch (error) {
			this.#fail(asError(error));
			throw error;
		}
	}

	#fail(error: Error): void {
		if (this.#failure) return;
		this.#failure = error;
		this.#rejectFailure(error);
		this.#clearTimers();
		this.#sink = undefined;
		this.#canAnnounce = () => false;
		for (const runtime of this.#runtime.values()) {
			this.#invokeDetach(runtime);
			this.#kill(runtime);
			runtime.fail(error);
		}
		this.#report(error);
	}

	#kill(runtime: RuntimeBatch): void {
		if (runtime.cancelCalled) return;
		runtime.cancelCalled = true;
		try {
			const result = runtime.cancel?.() as unknown;
			if (result && typeof (result as PromiseLike<unknown>).then === "function") {
				void Promise.resolve(result).catch((error: unknown) => this.#report(error));
			}
		} catch (error) {
			this.#report(error);
		}
	}

	#invokeDetach(runtime: RuntimeBatch): void {
		const onDetach = runtime.onDetach;
		runtime.onDetach = undefined;
		runtime.detached = true;
		try {
			onDetach?.();
		} catch (error) {
			this.#report(error);
		}
	}

	#isReady(): boolean {
		try {
			return this.#canAnnounce();
		} catch (error) {
			this.#report(error);
			return false;
		}
	}

	#background(promise: Promise<unknown>): void {
		void promise.catch((error: unknown) => this.#report(error));
	}

	#clearTimer(runId: string): void {
		const timer = this.#timers.get(runId);
		if (timer) clearTimeout(timer);
		this.#timers.delete(runId);
	}

	#clearTimers(): void {
		for (const timer of this.#timers.values()) clearTimeout(timer);
		this.#timers.clear();
	}

	#assertHealthy(): void {
		if (this.#failure) throw this.#failure;
		if (this.#closed) throw new Error("Durable run book is closed");
	}

	#report(error: unknown): void {
		try {
			this.#onError?.(asError(error));
		} catch {
			// Error reporting must not recursively fail the run book.
		}
	}
}

const copyStored = (record: StoredBatch): StoredBatch => ({
	runId: record.runId,
	agents: [...record.agents],
	startedAt: record.startedAt,
	state: record.state,
	detached: record.detached,
	claimed: record.claimed,
	announced: record.announced,
	results: record.results === null ? null : record.results.map((result) => copyJson(result)),
});

const copyJson = (value: JsonValue): JsonValue => {
	if (Array.isArray(value)) return value.map(copyJson);
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copyJson(item)]));
	}
	return value;
};

const cloneResults = (results: AgentResult[]): AgentResult[] => results.map((result) => ({ ...result }));

const asStoredResults = (results: AgentResult[]): JsonValue[] => cloneResults(results) as unknown as JsonValue[];

const copyResults = (results: JsonValue[] | null): AgentResult[] =>
	(results ?? []).map(copyJson) as unknown as AgentResult[];

const snapshotOf = (record: StoredBatch, includeResults = false): AgentBatchSnapshot => ({
	runId: record.runId,
	agents: [...record.agents],
	state: record.state,
	startedAt: record.startedAt,
	elapsedMs: Date.now() - record.startedAt,
	detached: record.detached,
	...(includeResults && record.results !== null ? { results: copyResults(record.results) } : {}),
});

/** The old runtime receives only a resumable handle, even if completion raced reload. */
const detachedOutcome = (record: StoredBatch): AgentWaitOutcome => ({
	state: "running",
	snapshot: { ...snapshotOf(record), state: "running", detached: true },
});

const interruptedResults = (record: StoredBatch): AgentResult[] =>
	record.agents.map((agent) => ({
		agent,
		ok: false,
		output: "",
		state: "failed",
		runId: record.runId,
		error: "Interrupted by process restart. External child execution is not automatically relaunched to avoid repeating external effects.",
	}));

const cancelledResults = (record: StoredBatch, error = "Run was cancelled before process restart."): AgentResult[] =>
	record.agents.map((agent) => ({
		agent,
		ok: false,
		output: "",
		state: "failed",
		runId: record.runId,
		error,
		failure: "cancelled",
	}));

const failureResult = (registration: AgentBatchRegistration, error: unknown): AgentResult[] =>
	registration.agents.map((agent) => ({
		agent,
		ok: false,
		output: "",
		state: "failed",
		runId: registration.runId,
		error: error instanceof Error ? error.message : String(error),
	}));

const prune = (records: Map<string, StoredBatch>, runtime?: Map<string, RuntimeBatch>): Map<string, StoredBatch> => {
	const history = [...records.values()]
		.filter((record) => record.state !== "running" && record.claimed)
		.sort((left, right) => left.startedAt - right.startedAt);
	const removable = history.filter((record) => !runtime?.get(record.runId)?.waiters);
	for (const record of removable.slice(0, Math.max(0, history.length - SETTLED_HISTORY))) records.delete(record.runId);
	return records;
};

const asError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));
