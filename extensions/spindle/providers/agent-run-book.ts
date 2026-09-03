/**
 * The live book of subagent batches: what lets a run outlive the `spindle_exec`
 * program that started it.
 *
 * A batch is registered here at launch, so:
 *  - a caller blocks for a bounded wait window and gets a `runId` back when it
 *    expires (`agents.wait` resumes waiting later),
 *  - a result nobody claimed goes to the completion sink, which injects it into
 *    the parent session, and
 *  - every live batch is cancellable: by the parent turn's abort signal while a
 *    caller is attached, and by `drain` at session teardown.
 *
 * Granularity is the *batch* (one `agents.run` / `agents.runAll` call), because
 * that is what the run-backend seam settles as a unit.
 *
 * See CONTEXT.md "Run lifetime and cancellation" for the failure modes this
 * replaced.
 */

import type { RunFailure } from "../agents/run.ts";

/** Structured value returned to the sandbox for a single run. */
export interface SpindleAgentResult {
	agent: string;
	ok: boolean;
	output: string;
	/**
	 * Lifecycle of the run this result describes. `running` is not a failure: the
	 * wait window expired and the child is still working.
	 */
	state: "done" | "failed" | "running";
	/** Handle for `agents.wait` / `agents.cancel`. */
	runId: string;
	/** Where the result was persisted. Absent when nothing landed on disk. */
	outputPath?: string;
	exitCode?: number;
	paneId?: string;
	error?: string;
	/**
	 * Why it failed, as a class (see `RunFailure`). `launch` in particular means
	 * the child never ran: the task is not what needs rethinking.
	 */
	failure?: RunFailure;
}

export type AgentBatchState = "running" | "settled" | "cancelled";

/** Caller-facing view of a batch, used by `agents.status`. */
export interface AgentBatchSnapshot {
	runId: string;
	agents: string[];
	state: AgentBatchState;
	startedAt: number;
	elapsedMs: number;
	/** True once no caller is blocked on it and it kept running. */
	detached: boolean;
	/** Only carried by a wait outcome; `list()` omits it (see `snapshotOf`). */
	results?: SpindleAgentResult[];
}

export interface AgentBatchRegistration {
	runId: string;
	agents: string[];
	/** Resolves when every run in the batch has settled. */
	promise: Promise<SpindleAgentResult[]>;
	/** Tear the batch down (kills the children). */
	cancel(): void;
	/** Called once when the batch stops being awaited and keeps running. */
	onDetach?(): void;
}

export interface AgentCompletionEvent {
	runId: string;
	agents: string[];
	results: SpindleAgentResult[];
	elapsedMs: number;
}

/** Where an unclaimed completion goes (see `spindle-state.ts`). */
export type AgentCompletionSink = (event: AgentCompletionEvent) => void;

export interface AgentWaitOutcome {
	state: AgentBatchState;
	snapshot: AgentBatchSnapshot;
	/** Present only for a settled (or cancelled) batch. */
	results?: SpindleAgentResult[];
}

/**
 * Grace period before an unclaimed completion is announced. A batch that
 * settles microseconds after a wait window expired is still claimed by that
 * waiter, so the parent never gets both a tool result and an event for it.
 */
const ANNOUNCE_DELAY_MS = 150;

/** How many settled batches stay queryable by `agents.wait` / `agents.status`. */
export const SETTLED_HISTORY = 50;

interface Batch {
	runId: string;
	agents: string[];
	startedAt: number;
	promise: Promise<SpindleAgentResult[]>;
	cancel(): void;
	onDetach?(): void;
	settled: Promise<void>;
	markSettled(): void;
	state: AgentBatchState;
	results?: SpindleAgentResult[];
	/** Some caller took the terminal results, so nothing gets announced. */
	claimed: boolean;
	/** Callers currently blocked on this batch. */
	waiters: number;
	detached: boolean;
	cancelled: boolean;
}

export class AgentRunBook {
	readonly #batches = new Map<string, Batch>();
	readonly #announceDelayMs: number;
	#sink: AgentCompletionSink | undefined;

	constructor(options: { announceDelayMs?: number } = {}) {
		this.#announceDelayMs = options.announceDelayMs ?? ANNOUNCE_DELAY_MS;
	}

	/**
	 * Install the completion sink. Replaces any previous one, and flushes results
	 * that settled while there was no sink to take them (otherwise they would be
	 * lost for good).
	 */
	setSink(sink: AgentCompletionSink | undefined): void {
		this.#sink = sink;
		if (!sink) return;
		for (const batch of this.#batches.values()) this.#announce(batch);
	}

	register(registration: AgentBatchRegistration): void {
		let markSettled = (): void => {};
		const settled = new Promise<void>((resolve) => {
			markSettled = resolve;
		});
		const batch: Batch = {
			runId: registration.runId,
			agents: [...registration.agents],
			startedAt: Date.now(),
			promise: registration.promise,
			cancel: registration.cancel,
			...(registration.onDetach ? { onDetach: registration.onDetach } : {}),
			settled,
			markSettled,
			state: "running",
			claimed: false,
			waiters: 0,
			detached: false,
			cancelled: false,
		};
		this.#batches.set(batch.runId, batch);
		registration.promise.then(
			(results) => this.#settle(batch, results),
			(error: unknown) => this.#settle(batch, [failureResult(batch, error)]),
		);
	}

	/**
	 * Block on a batch for at most `waitMs`. An expired window is a normal
	 * outcome, not an error: the batch is marked detached (its parent-turn abort
	 * link is dropped) and the caller gets a `running` snapshot to poll.
	 */
	async wait(runId: string, waitMs: number): Promise<AgentWaitOutcome> {
		const batch = this.#batches.get(runId);
		if (!batch) throw new Error(`Unknown subagent run: ${runId}`);
		if (batch.results) return this.#claim(batch);
		if (waitMs <= 0) {
			this.#detach(batch);
			return { state: batch.state, snapshot: snapshotOf(batch, true) };
		}
		batch.waiters++;
		try {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const expiry = new Promise<"expired">((resolve) => {
				// Not unref'd: a caller is blocked on this timer, so it has to keep the
				// event loop alive until the window closes.
				timer = setTimeout(() => resolve("expired"), waitMs);
			});
			try {
				await Promise.race([batch.settled, expiry]);
			} finally {
				if (timer) clearTimeout(timer);
			}
			// Checked after the race regardless of which side won: the batch can
			// settle in the same tick the window expires.
			if (batch.results) return this.#claim(batch);
		} finally {
			batch.waiters--;
		}
		this.#detach(batch);
		return { state: batch.state, snapshot: snapshotOf(batch, true) };
	}

	/**
	 * Live and recent batches. Results are omitted: a settled history of 50 full
	 * subagent outputs would blow the caller's result budget.
	 */
	list(): AgentBatchSnapshot[] {
		return [...this.#batches.values()].map((batch) => snapshotOf(batch, false));
	}

	/**
	 * Cancel one batch (or every live one). Returns the run ids torn down.
	 *
	 * A cancelled batch is never announced: whoever cancelled it does not want its
	 * result delivered as a follow-up message. This is also the path a parent-turn
	 * abort takes, so an abandoned caller cannot leave a result addressed to
	 * nobody.
	 */
	cancel(runId?: string): string[] {
		const targets = runId
			? [this.#batches.get(runId)].filter((batch): batch is Batch => batch !== undefined)
			: [...this.#batches.values()];
		const cancelled: string[] = [];
		for (const batch of targets) {
			if (batch.results) continue;
			batch.cancelled = true;
			batch.claimed = true;
			// Reported as cancelled immediately: the children may take a moment to
			// die, but the batch's outcome is already decided.
			batch.state = "cancelled";
			try {
				batch.cancel();
			} catch {
				// Teardown is best-effort; a backend that already died still counts.
			}
			cancelled.push(batch.runId);
		}
		if (runId && cancelled.length === 0 && !this.#batches.has(runId)) {
			throw new Error(`Unknown subagent run: ${runId}`);
		}
		return cancelled;
	}

	/** Drop every record, cancelling whatever is still live. */
	reset(): void {
		this.cancel();
		this.#batches.clear();
	}

	/**
	 * Cancel everything and wait (up to `timeoutMs`) for the children to actually
	 * die. Session teardown has to await this: the kill escalates SIGTERM ->
	 * SIGKILL on a timer, so returning immediately can leave the host exiting
	 * before the SIGKILL lands, which is how a subagent becomes an orphan.
	 *
	 * Returns true when every batch settled within the budget.
	 */
	async drain(timeoutMs: number): Promise<boolean> {
		this.cancel();
		const pending = [...this.#batches.values()].filter((batch) => !batch.results).map((batch) => batch.promise);
		this.#batches.clear();
		if (pending.length === 0) return true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const expiry = new Promise<boolean>((resolve) => {
			timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
		});
		try {
			return await Promise.race([Promise.allSettled(pending).then(() => true), expiry]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	#claim(batch: Batch): AgentWaitOutcome {
		batch.claimed = true;
		return {
			state: batch.state,
			snapshot: snapshotOf(batch, true),
			...(batch.results ? { results: batch.results } : {}),
		};
	}

	#detach(batch: Batch): void {
		if (batch.detached || batch.results) return;
		batch.detached = true;
		try {
			batch.onDetach?.();
		} catch {
			// Detaching is bookkeeping; never fail the caller over it.
		}
	}

	#settle(batch: Batch, results: SpindleAgentResult[]): void {
		if (batch.results) return;
		batch.results = results;
		if (!batch.cancelled) batch.state = "settled";
		batch.markSettled();
		this.#prune();
		if (batch.claimed) return;
		const timer = setTimeout(() => this.#announce(batch), this.#announceDelayMs);
		timer.unref?.();
	}

	#announce(batch: Batch): void {
		if (batch.claimed || batch.waiters > 0) return;
		const sink = this.#sink;
		const results = batch.results;
		if (!sink || !results) return;
		batch.claimed = true;
		try {
			sink({
				runId: batch.runId,
				agents: batch.agents,
				results,
				elapsedMs: Date.now() - batch.startedAt,
			});
		} catch {
			// A failing sink must not take the run book down with it.
		}
	}

	/** Keep the map bounded: settled batches age out oldest-first. */
	#prune(): void {
		const finished = [...this.#batches.values()].filter((batch) => batch.results !== undefined);
		if (finished.length <= SETTLED_HISTORY) return;
		finished.sort((left, right) => left.startedAt - right.startedAt);
		for (const batch of finished.slice(0, finished.length - SETTLED_HISTORY)) {
			this.#batches.delete(batch.runId);
		}
	}
}

const snapshotOf = (batch: Batch, includeResults: boolean): AgentBatchSnapshot => ({
	runId: batch.runId,
	agents: [...batch.agents],
	state: batch.state,
	startedAt: batch.startedAt,
	elapsedMs: Date.now() - batch.startedAt,
	detached: batch.detached,
	...(includeResults && batch.results ? { results: batch.results } : {}),
});

/** A batch whose backend rejected outright still has to settle as a result. */
const failureResult = (batch: Batch, error: unknown): SpindleAgentResult => ({
	agent: batch.agents[0] ?? "agent",
	ok: false,
	output: "",
	state: "failed",
	runId: batch.runId,
	error: error instanceof Error ? error.message : String(error),
});
