/** Reload-stable named conversations, durable admissions and native-parent notification receipts. */
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSession, defineDoc, type Storage } from "@earendil-works/pi-durable";
import { readActiveNightRun, isNightRunParticipant, type ActiveNightRun } from "../night-mode/night-run.ts";
import type { AgentWorkspace } from "../night-mode/agent-workspace.ts";
import { builtinAgent } from "./discovery.ts";
import { openDurableStorage } from "./durable-storage.ts";
import { openConversationWorker, type WorkerConnection, type WorkerFactory } from "./conversation-backend.ts";
import { allocateNightWorkspaces, releaseNightWorkspaces, relocateWorkspacePaths } from "./night-workspace.ts";
import { sanitizeSegment } from "./paths.ts";
import { validateHostModel, type HostModel } from "./persistent-model.ts";
import type { LastAnswer, WorkerAnswer, WorkerSpec, WorkerStatus } from "./worker-protocol.ts";
import type { SessionRef } from "./session-ref.ts";
import { resolveSpawnDirectory } from "./spawn-directory.ts";

const ctx = BACKGROUND_CONTEXT;
const RegistryDoc = defineDoc<{ agents: Record<string, JsonValue> }>({
	kind: "pi.subagents.named-conversations",
	version: 1,
	scope: "session",
	initial: () => ({ agents: {} }),
});
type Input = { id: string; message: string; followUp: boolean; state: "pending" | "done" | "aborted" | "failed" };
type Notice = { id: string; text: string; error?: string; announced: boolean };
interface NamedRecord {
	name: string;
	id: string;
	spawnCallId: string;
	spec: WorkerSpec;
	createdAt: number;
	conversationId?: string;
	lastAnswer?: LastAnswer;
	error?: string;
	inputs: Input[];
	deadlineAt?: number;
	stopRequested?: string;
	notices: Notice[];
	/** Exact answer IDs returned by named status, including receipts not yet received. */
	observedAnswers?: string[];
	workspaces: AgentWorkspace[];
	retired?: boolean;
}
export interface SubagentStatus {
	name: string;
	state: "working" | "idle";
	conversationId?: string;
	lastAnswer?: LastAnswer;
	error?: string;
}
export interface SpawnPolicy extends HostModel {
	timeoutMs: number;
}
export interface SubagentReport {
	name: string;
	conversationId?: string;
	answerId: string;
	text: string;
	error?: string;
}
interface LiveWorker {
	connection: WorkerConnection;
	restored: Promise<void>;
	deadline?: ReturnType<typeof setTimeout>;
	park?: ReturnType<typeof setTimeout>;
}
const keyOf = (name: string) => `agent:${name}`;
const copy = <T>(value: T): T => structuredClone(value);
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value));
const pending = (record: NamedRecord) => record.inputs.filter((input) => input.state === "pending");
const asStatus = (record: NamedRecord, includeAnswer = true): SubagentStatus => ({
	name: record.name,
	state: pending(record).length ? "working" : "idle",
	...(record.conversationId ? { conversationId: record.conversationId } : {}),
	...(includeAnswer && record.lastAnswer ? { lastAnswer: copy(record.lastAnswer) } : {}),
	...(record.error ? { error: record.error } : {}),
});

function mergeStatus(record: NamedRecord, status: WorkerStatus): void {
	record.conversationId = status.conversationId;
	const latest = status.lastAnswer;
	// Canonical entry IDs are ordered within this child's database. IPC/Reporter
	// completion order is not generation order, especially for steered inputs.
	if (
		latest &&
		(!record.lastAnswer ||
			(/^\d+$/.test(latest.id) &&
				/^\d+$/.test(record.lastAnswer.id) &&
				BigInt(latest.id) >= BigInt(record.lastAnswer.id)))
	)
		record.lastAnswer = copy(latest);
}

export function durableDirectory(ref: SessionRef): string {
	if (!ref.sessionFile || !ref.sessionId) throw new Error("Durable subagents require a file-backed parent session");
	const identity = createHash("sha256")
		.update(JSON.stringify([ref.sessionId, resolve(ref.cwd)]))
		.digest("hex");
	return resolve(`${ref.sessionFile}.subagents-durable`, identity);
}

/** Night policy comes from the active host contract, never caller names or messages. */
export function activeNightForSession(ref: SessionRef, run = readActiveNightRun()): ActiveNightRun | undefined {
	if (!run) {
		if (process.env.PI_NIGHT_RUN === "1")
			throw new Error("Active night contract unavailable; refusing an unprotected subagent");
		return undefined;
	}
	if (!isNightRunParticipant(run, ref)) return undefined;
	return copy(run);
}

export class DurableSupervisor {
	readonly format = "named-conversations-v3";
	readonly #session;
	#records = new Map<string, NamedRecord>();
	#workers = new Map<string, LiveWorker>();
	#serial = new Map<string, Promise<unknown>>();
	#tail: Promise<void> = Promise.resolve();
	#listeners = new Set<() => void>();
	#sink?: (report: SubagentReport) => void;
	#readyToAnnounce: () => boolean = () => true;
	#errorHandler?: (error: unknown) => void;
	#factory: WorkerFactory;
	#closing?: Promise<void>;
	#closed = false;
	#pausing = false;
	#failure?: Error;
	#attempts = new Map<string, number>();
	#retries = new Map<string, ReturnType<typeof setTimeout>>();

	private constructor(
		storage: Storage,
		readonly ref: SessionRef,
		factory: WorkerFactory,
		readonly release: () => void,
	) {
		this.#session = createSession(storage);
		this.#factory = factory;
	}
	static async open(ref: SessionRef, factory: WorkerFactory = openConversationWorker): Promise<DurableSupervisor> {
		const owned = await openDurableStorage(durableDirectory(ref));
		const supervisor = new DurableSupervisor(owned.storage, copy(ref), factory, owned.release);
		try {
			await supervisor.#session.commit(async (tx) => {
				await tx.doc(RegistryDoc);
			}, ctx);
			const snapshot = await supervisor.#session.snapshot(RegistryDoc, ctx);
			supervisor.#records = new Map(
				Object.entries(snapshot!.agents).map(([key, value]) => [key, value as unknown as NamedRecord]),
			);
			for (const record of supervisor.#records.values())
				if (!record.retired && (pending(record).length || record.stopRequested))
					supervisor.#background(supervisor.#dispatch(record));
			return supervisor;
		} catch (error) {
			await supervisor.#session.close(ctx).catch(() => {});
			owned.release();
			throw error;
		}
	}
	replaceWorkerFactory(factory: WorkerFactory): void {
		this.#factory = factory;
	}
	setErrorHandler(handler?: (error: unknown) => void): void {
		this.#errorHandler = handler;
	}
	setSink(sink?: (report: SubagentReport) => void, ready: () => boolean = () => true): void {
		this.#sink = sink;
		this.#readyToAnnounce = ready;
		if (sink) this.#background(this.flushReports());
	}
	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
	suspend(): void {
		this.#sink = undefined;
		this.#errorHandler = undefined;
		this.#listeners.clear();
	}
	list(): SubagentStatus[] {
		return [...this.#records.values()].map((record) => asStatus(record, false));
	}
	#healthy(): void {
		if (this.#failure) throw this.#failure;
		if (this.#closed) throw new Error("Subagent supervisor is closed");
	}
	#record(name: string): NamedRecord {
		const record = this.#records.get(keyOf(name));
		if (!record) throw new Error(`No subagent named ${name}.`);
		return record;
	}
	#locked<T>(name: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.#serial.get(name) ?? Promise.resolve();
		const current = previous.catch(() => {}).then(operation);
		this.#serial.set(name, current);
		void current
			.finally(() => {
				if (this.#serial.get(name) === current) this.#serial.delete(name);
			})
			.catch(() => {});
		return current;
	}
	#change<T>(operation: (records: Map<string, NamedRecord>) => T): Promise<T> {
		const result = this.#tail.then(async () => {
			this.#healthy();
			const records = copy(this.#records);
			const value = operation(records);
			try {
				await this.#session.commit(async (tx) => {
					(await tx.doc(RegistryDoc)).agents = Object.fromEntries(
						[...records].map(([key, record]) => [key, json(record)]),
					);
				}, ctx);
				this.#records = records;
				for (const listener of this.#listeners) {
					try {
						listener();
					} catch {}
				}
				return value;
			} catch (error) {
				this.#failure = error instanceof Error ? error : new Error(String(error));
				for (const worker of this.#workers.values()) void worker.connection.cancel().catch(() => {});
				throw error;
			}
		});
		this.#tail = result.then(
			() => {},
			() => {},
		);
		return result;
	}

	spawn(name: string, message: string, callId: string, policy: SpawnPolicy, cwd?: string): Promise<SubagentStatus> {
		return this.#locked(name, async () => {
			this.#healthy();
			if (this.#closing) throw new Error("Subagents are shutting down");
			const night = activeNightForSession(this.ref);
			if (night && cwd !== undefined)
				throw new Error("Night subagent placement is host-controlled; cwd is not allowed");
			const placement = await resolveSpawnDirectory(cwd, this.ref);
			const existing = this.#records.get(keyOf(name));
			if (existing) {
				if (existing.spawnCallId === callId && existing.inputs[0]?.message === message) {
					if (resolve(existing.spec.context.cwd) !== resolve(placement.cwd))
						throw new Error("Spawn input ID reused with a different cwd");
					return asStatus(existing);
				}
				throw new Error(`${name} already exists; use send.`);
			}
			const model = validateHostModel(policy, this.ref.cwd, this.ref.projectTrusted);
			const id = randomUUID();
			const agent = builtinAgent();
			agent.config.name = name;
			agent.config.systemPromptMode = "append";
			agent.systemPrompt = `You are the subagent ${JSON.stringify(name)}. Answer the main agent's requests. You cannot launch subagents or background jobs.`;
			const request: WorkerSpec["request"] = {
				agent,
				task: message,
				index: 0,
				overrides: { model: model.model, ...(model.thinking ? { thinking: model.thinking } : {}) },
				...(night ? { night: true } : {}),
			};
			const workspaces = await allocateNightWorkspaces([request], id, this.ref.cwd, night);
			const now = Date.now();
			const record: NamedRecord = {
				name,
				id,
				spawnCallId: callId,
				createdAt: now,
				inputs: [{ id: callId, message, followUp: false, state: "pending" }],
				notices: [],
				workspaces,
				deadlineAt: now + policy.timeoutMs,
				spec: {
					name,
					request,
					directory: join(
						dirname(this.ref.sessionFile!),
						"subagent-runs",
						sanitizeSegment(this.ref.sessionId!),
						id,
						`${sanitizeSegment(name)}.durable`,
					),
					context: {
						...this.ref,
						...placement,
						sessionId: this.ref.sessionId,
						sessionFile: this.ref.sessionFile,
						runId: id,
						timeoutMs: policy.timeoutMs,
						...(night ? { nightRun: night } : {}),
					},
				},
			};
			try {
				if (this.#closing) throw new Error("Subagents are shutting down");
				if (JSON.stringify(activeNightForSession(this.ref)) !== JSON.stringify(night))
					throw new Error("Night contract changed during subagent admission");
				await this.#change((records) => {
					records.set(keyOf(name), record);
				});
			} catch (error) {
				await releaseNightWorkspaces(workspaces);
				throw error;
			}
			await this.#dispatch(this.#record(name), callId);
			return asStatus(this.#record(name));
		});
	}
	send(name: string, message: string, followUp: boolean, callId: string): Promise<SubagentStatus> {
		return this.#locked(name, async () => {
			this.#healthy();
			if (this.#closing) throw new Error("Subagents are shutting down");
			let record = this.#record(name);
			const currentNight = activeNightForSession(this.ref);
			if (record.retired || JSON.stringify(currentNight) !== JSON.stringify(record.spec.context.nightRun))
				throw new Error("This subagent belongs to a different night run; spawn a new named worker.");
			const repeated = record.inputs.find((input) => input.id === callId);
			if (repeated) {
				if (repeated.message !== message || repeated.followUp !== followUp)
					throw new Error("Input ID reused with different content");
				return asStatus(record);
			}
			if (record.stopRequested || (pending(record).length && record.deadlineAt! <= Date.now())) {
				await this.#dispatch(record);
				record = this.#record(name);
			}
			await this.#change((records) => {
				const latest = records.get(keyOf(name))!;
				if (!pending(latest).length) latest.deadlineAt = Date.now() + latest.spec.context.timeoutMs;
				latest.error = undefined;
				latest.inputs.push({ id: callId, message, followUp, state: "pending" });
			});
			await this.#dispatch(this.#record(name), callId);
			return asStatus(this.#record(name));
		});
	}
	stop(name: string): Promise<SubagentStatus> {
		return this.#locked(name, async () => {
			this.#healthy();
			if (this.#closing) throw new Error("Subagents are shutting down");
			const record = this.#record(name);
			if (record.retired) return asStatus(record);
			await this.#change((records) => {
				records.get(keyOf(name))!.stopRequested = randomUUID();
			});
			await this.#dispatch(this.#record(record.name));
			return asStatus(this.#record(name));
		});
	}
	status(name: string): Promise<SubagentStatus> {
		return this.#locked(name, async () => {
			this.#healthy();
			if (this.#closing) throw new Error("Subagents are shutting down");
			const record = this.#record(name);
			if (record.retired) return this.#readStatus(name);
			try {
				await this.#dispatch(record);
				const worker = this.#workers.get(record.id);
				if (worker) await this.#statusChanged(name, await worker.connection.status());
			} catch (error) {
				this.#report(error);
			}
			return this.#readStatus(name);
		});
	}

	#readStatus(name: string): Promise<SubagentStatus> {
		return this.#change((records) => {
			const record = records.get(keyOf(name))!;
			const id = record.lastAnswer?.id;
			if (id) {
				const observed = (record.observedAnswers ??= []);
				if (!observed.includes(id)) observed.push(id);
				for (const notice of record.notices) if (notice.id === id) notice.announced = true;
			}
			// Keep the answer available. Only its pending automatic notification is acknowledged.
			return asStatus(record);
		});
	}

	async #statusChanged(name: string, status: WorkerStatus): Promise<void> {
		if (this.#closing || this.#closed) return;
		await this.#change((records) => {
			mergeStatus(records.get(keyOf(name))!, status);
		});
	}
	async #dispatch(record: NamedRecord, inputId?: string): Promise<void> {
		this.#healthy();
		if (this.#closing) throw new Error("Subagents are shutting down");
		if (record.retired) throw new Error("This night subagent has been retired");
		let live = this.#workers.get(record.id);
		if (!live) {
			const spec = copy(record.spec);
			spec.context.deadlineAt = record.deadlineAt;
			spec.stopOnOpen = !!record.stopRequested || (!!pending(record).length && record.deadlineAt! <= Date.now());
			let connection: WorkerConnection;
			try {
				connection = this.#factory(spec, {
					answer: (id, answer, status) => this.#background(this.#answer(record.name, id, answer, status)),
					exit: (error) => this.#background(this.#workerExited(record.name, connection, error)),
				});
			} catch (error) {
				await this.#terminalFailure(record.name, error);
				throw error;
			}
			live = { connection, restored: Promise.resolve() };
			this.#workers.set(record.id, live);
			live.restored = (async () => {
				await this.#statusChanged(record.name, await connection.ready);
				if (this.#closing) return;
				const current = this.#record(record.name);
				if (current.stopRequested || (pending(current).length && current.deadlineAt! <= Date.now())) {
					await this.#finishStop(
						current,
						connection,
						current.stopRequested ? undefined : "Subagent answer lifetime expired",
					);
				} else {
					for (const input of pending(current)) {
						if (this.#closing || this.#closed) return;
						await this.#statusChanged(
							current.name,
							await connection.input(input.id, input.message, input.followUp),
						);
					}
				}
				this.#arm(record.name);
			})();
			await live.restored;
		} else {
			await live.restored;
			if (this.#closing) return;
			const current = this.#record(record.name);
			if (current.stopRequested || (pending(current).length && current.deadlineAt! <= Date.now()))
				await this.#finishStop(
					current,
					live.connection,
					current.stopRequested ? undefined : "Subagent answer lifetime expired",
				);
			else if (inputId) {
				const input = pending(current).find((item) => item.id === inputId);
				if (input)
					await this.#statusChanged(
						record.name,
						await live.connection.input(input.id, input.message, input.followUp),
					);
			}
			this.#arm(record.name);
		}
	}
	async #finishStop(record: NamedRecord, connection: WorkerConnection, error?: string): Promise<void> {
		const id = record.stopRequested ?? randomUUID();
		if (!record.stopRequested)
			await this.#change((records) => {
				records.get(keyOf(record.name))!.stopRequested = id;
			});
		let stopFailure: unknown;
		try {
			await this.#statusChanged(record.name, await connection.stop(id));
		} catch (failure) {
			stopFailure = failure;
			await connection.cancel();
		}
		await this.#change((records) => {
			const current = records.get(keyOf(record.name))!;
			for (const input of pending(current)) input.state = "aborted";
			current.stopRequested = stopFailure ? id : undefined;
			current.deadlineAt = undefined;
			current.error =
				error ??
				(stopFailure instanceof Error ? stopFailure.message : stopFailure ? String(stopFailure) : current.error);
			if (error) current.notices.push({ id: `timeout:${id}`, text: error, error, announced: false });
		});
		this.#background(this.flushReports());
		if (stopFailure) throw stopFailure;
	}
	async #answer(name: string, id: string, result: WorkerAnswer, status: WorkerStatus): Promise<void> {
		if (this.#pausing || this.#closed || this.#failure) return;
		await this.#change((records) => {
			const record = records.get(keyOf(name));
			if (!record) return;
			const input = record.inputs.find((item) => item.id === id);
			if (!input || input.state !== "pending") return;
			input.state = result.aborted ? "aborted" : result.ok ? "done" : "failed";
			mergeStatus(record, status);
			if (result.answer) {
				mergeStatus(record, { ...status, lastAnswer: result.answer });
				record.error = undefined;
				if (!record.notices.some((notice) => notice.id === result.answer!.id))
					record.notices.push({
						id: result.answer.id,
						text: result.answer.text,
						announced: record.observedAnswers?.includes(result.answer.id) ?? false,
					});
			} else if (!result.aborted && result.error) {
				record.error = result.error;
				if (!record.notices.some((notice) => notice.id === `failure:${id}`))
					record.notices.push({ id: `failure:${id}`, text: result.error, error: result.error, announced: false });
			}
			if (!pending(record).length) record.deadlineAt = undefined;
		});
		this.#attempts.delete(this.#record(name).id);
		this.#arm(name);
		this.#background(this.flushReports());
	}
	#arm(name: string): void {
		if (this.#closing || this.#closed) return;
		const record = this.#record(name);
		const worker = this.#workers.get(record.id);
		if (!worker) return;
		if (worker.deadline) clearTimeout(worker.deadline);
		if (worker.park) clearTimeout(worker.park);
		if (pending(record).length && record.deadlineAt) {
			worker.deadline = setTimeout(
				() =>
					this.#background(
						this.#locked(name, async () => {
							if (pending(this.#record(name)).length && this.#record(name).deadlineAt! <= Date.now())
								await this.#finishStop(
									this.#record(name),
									worker.connection,
									"Subagent answer lifetime expired",
								);
						}),
					),
				Math.max(1, record.deadlineAt - Date.now()),
			);
			worker.deadline.unref();
		} else {
			worker.park = setTimeout(
				() =>
					this.#background(
						this.#locked(name, async () => {
							if (!pending(this.#record(name)).length && this.#workers.get(record.id) === worker) {
								this.#workers.delete(record.id);
								await worker.connection.pause();
							}
						}),
					),
				30_000,
			);
			worker.park.unref();
		}
	}
	async #workerExited(name: string, connection: WorkerConnection, error?: Error): Promise<void> {
		const record = this.#records.get(keyOf(name));
		if (!record) return;
		const worker = this.#workers.get(record.id);
		if (worker?.connection !== connection) return;
		if (worker.deadline) clearTimeout(worker.deadline);
		if (worker.park) clearTimeout(worker.park);
		this.#workers.delete(record.id);
		if (this.#closing || this.#closed || this.#failure || !error) return;
		const attempts = (this.#attempts.get(record.id) ?? 0) + 1;
		this.#attempts.set(record.id, attempts);
		if (pending(record).length && attempts < 3 && record.deadlineAt! > Date.now()) {
			await this.#change((records) => {
				records.get(keyOf(name))!.error = error.message;
			});
			const retry = setTimeout(() => {
				this.#retries.delete(record.id);
				if (!this.#closing) this.#background(this.#locked(name, () => this.#dispatch(this.#record(name))));
			}, 250);
			retry.unref();
			this.#retries.set(record.id, retry);
		} else if (pending(record).length) await this.#terminalFailure(name, error);
	}
	async #terminalFailure(name: string, error: unknown): Promise<void> {
		const text = error instanceof Error ? error.message : String(error);
		await this.#change((records) => {
			const record = records.get(keyOf(name))!;
			record.error = text;
			record.stopRequested = randomUUID();
			for (const input of pending(record)) input.state = "failed";
			record.notices.push({ id: `launch:${record.stopRequested}`, text, error: text, announced: false });
		});
		this.#background(this.flushReports());
	}
	async flushReports(): Promise<void> {
		for (const record of [...this.#records.values()]) {
			for (const notice of record.notices.filter((item) => !item.announced)) {
				// A named status already in progress wins over a pending notification.
				await this.#locked(record.name, async () => {
					const sink = this.#sink;
					if (!sink || this.#closing || !this.#readyToAnnounce()) return;
					const report = await this.#change((records) => {
						const current = records.get(keyOf(record.name))!;
						const latest = current.notices.find((item) => item.id === notice.id)!;
						if (latest.announced) return undefined;
						latest.announced = true;
						return {
							name: current.name,
							conversationId: current.conversationId,
							answerId: latest.id,
							text: latest.text,
							error: latest.error,
						};
					});
					// Native delivery is at-most-once; the durable answer stays readable.
					if (report && this.#sink === sink && !this.#closing && this.#readyToAnnounce()) {
						try {
							sink(report);
						} catch (error) {
							this.#report(error);
						}
					}
				});
			}
		}
	}
	close(options: { preserveRuns?: boolean } = {}): Promise<void> {
		if (this.#closing) return this.#closing;
		this.suspend();
		this.#pausing = true;
		this.#closing = Promise.resolve().then(async () => {
			try {
				for (const timer of this.#retries.values()) clearTimeout(timer);
				this.#retries.clear();
				if (!options.preserveRuns && !this.#failure)
					await this.#change((records) => {
						for (const record of records.values()) record.stopRequested = randomUUID();
					});
				for (const worker of this.#workers.values()) {
					if (worker.deadline) clearTimeout(worker.deadline);
					if (worker.park) clearTimeout(worker.park);
				}
				await Promise.allSettled(
					[...this.#workers.values()].map((worker) =>
						options.preserveRuns ? worker.connection.pause() : worker.connection.cancel(),
					),
				);
				await Promise.allSettled([...this.#serial.values()]);
				this.#workers.clear();
				if (!options.preserveRuns && !this.#failure) {
					for (const record of this.#records.values()) await releaseNightWorkspaces(record.workspaces);
					await this.#change((records) => {
						for (const record of records.values()) {
							for (const input of pending(record)) input.state = "aborted";
							if (record.lastAnswer)
								record.lastAnswer.text = relocateWorkspacePaths(
									{ output: record.lastAnswer.text },
									record.workspaces,
								).output;
							if (record.workspaces.length) {
								record.spec.request.cwd = undefined;
								record.spec.request.artifactsDir = undefined;
							}
							record.workspaces = [];
							record.deadlineAt = undefined;
							if (record.spec.context.nightRun) {
								record.retired = true;
								record.stopRequested = undefined;
							}
							// Preserve stop intent for parked/crashed kernels whose abort could not be committed.
						}
					});
				}
				await this.#tail;
			} finally {
				this.#closed = true;
				try {
					await this.#session.close(ctx);
				} finally {
					this.release();
				}
			}
		});
		return this.#closing;
	}
	#background(promise: Promise<unknown>): void {
		void promise.catch((error) => this.#report(error));
	}
	#report(error: unknown): void {
		try {
			this.#errorHandler?.(error);
		} catch {}
	}
}

interface Slot {
	entry: Promise<DurableSupervisor>;
	closing?: Promise<void>;
}
// Reuse the previous registry key so an architecture upgrade can close its old owner safely.
const SUPERVISORS = Symbol.for("babariviere.pi-extensions.durable-supervisors.v2");
function supervisors(): Map<string, Slot> {
	const state = globalThis as typeof globalThis & { [key: symbol]: Map<string, Slot> | undefined };
	return (state[SUPERVISORS] ??= new Map());
}
export async function acquireDurableSupervisor(
	ref: SessionRef,
	factory: WorkerFactory = openConversationWorker,
): Promise<DurableSupervisor> {
	const key = durableDirectory(ref);
	const entries = supervisors();
	const existing = entries.get(key);
	if (existing?.closing) {
		await existing.closing;
		return acquireDurableSupervisor(ref, factory);
	}
	if (existing) {
		const active = await existing.entry;
		if (existing.closing || entries.get(key) !== existing) return acquireDurableSupervisor(ref, factory);
		const format = (active as { format?: string }).format;
		if (format !== "named-conversations-v3") {
			// Compatible named-conversation upgrades pause and reopen the same journal.
			// Old job handles cannot become names, so those owners still retire their work.
			existing.closing = (async () => {
				try {
					await active.close({
						preserveRuns: format === "named-conversations-v1" || format === "named-conversations-v2",
					});
				} finally {
					if (entries.get(key) === existing) entries.delete(key);
				}
			})();
			await existing.closing;
			return acquireDurableSupervisor(ref, factory);
		}
		active.replaceWorkerFactory(factory);
		return active;
	}
	const slot: Slot = { entry: DurableSupervisor.open(ref, factory) };
	entries.set(key, slot);
	try {
		const active = await slot.entry;
		if (slot.closing || entries.get(key) !== slot) return acquireDurableSupervisor(ref, factory);
		return active;
	} catch (error) {
		if (entries.get(key) === slot) entries.delete(key);
		throw error;
	}
}
export async function closeDurableSupervisor(ref: SessionRef, options: { preserveRuns?: boolean } = {}): Promise<void> {
	if (!ref.sessionFile || !ref.sessionId) return;
	const key = durableDirectory(ref);
	const entries = supervisors();
	const slot = entries.get(key);
	if (!slot) return;
	return (slot.closing ??= (async () => {
		try {
			await (await slot.entry).close(options);
		} finally {
			if (entries.get(key) === slot) entries.delete(key);
		}
	})());
}
