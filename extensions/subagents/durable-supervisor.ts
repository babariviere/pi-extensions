/** Reload-stable owner of admissions and their resumable Harness workers. */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { SessionRef } from "./agents-provider.ts";
import { RunLauncher } from "./backend.ts";
import { AgentRunRegistry } from "./agent-run-monitor.ts";
import type { AgentBatchRegistration, AgentResult } from "./agent-run-book.ts";
import { DurableRunBook } from "./durable-run-book.ts";
import { openDurableStorage } from "./durable-storage.ts";
import { runConversationBatch } from "./conversation-backend.ts";
import { DURABLE_PAUSE_REASON, type RecoveryPayload } from "./recovery.ts";
import { relocateWorkspacePaths, releaseNightWorkspaces } from "./night-workspace.ts";
import type { RunBackend } from "./run.ts";

export function durableDirectory(ref: SessionRef): string {
	if (!ref.sessionFile || !ref.sessionId) throw new Error("Durable subagents require a file-backed parent session");
	const identity = createHash("sha256")
		.update(JSON.stringify([ref.sessionId, resolve(ref.cwd)]))
		.digest("hex");
	return resolve(`${ref.sessionFile}.subagents-durable`, identity);
}

export class DurableSupervisor {
	readonly registry = new AgentRunRegistry();
	#errorHandler: ((error: unknown) => void) | undefined;
	#closing: Promise<void> | undefined;
	private constructor(
		readonly book: DurableRunBook,
		readonly launcher: RunLauncher,
		readonly release: () => void,
	) {}

	static async open(directory: string, backend: RunBackend): Promise<DurableSupervisor> {
		const owned = await openDurableStorage(directory);
		const launcher = new RunLauncher(backend);
		let supervisor: DurableSupervisor | undefined;
		try {
			const book = await DurableRunBook.open(owned.storage, {
				onError: (error) => {
					if (supervisor) supervisor.#report(error);
				},
				resume: (payload, runId) => resumeBatch(launcher, payload, runId),
			});
			supervisor = new DurableSupervisor(book, launcher, owned.release);
			return supervisor;
		} catch (error) {
			owned.release();
			throw error;
		}
	}
	setErrorHandler(handler: ((error: unknown) => void) | undefined): void {
		this.#errorHandler = handler;
	}
	#report(error: unknown): void {
		try {
			this.#errorHandler?.(error);
		} catch {}
	}
	async suspend(): Promise<void> {
		this.#errorHandler = undefined;
		await this.book.suspend();
	}
	close(options: { preserveRuns?: boolean } = {}): Promise<void> {
		return (this.#closing ??= (async () => {
			this.#errorHandler = undefined;
			try {
				if (!options.preserveRuns) await this.book.drain(5_000);
				await this.book.close(options);
			} finally {
				this.release();
			}
		})());
	}
}

function resumeBatch(
	launcher: RunLauncher,
	payload: RecoveryPayload,
	runId: string,
): Omit<AgentBatchRegistration, "runId" | "agents"> {
	const controller = new AbortController();
	const promise = (async (): Promise<AgentResult[]> => {
		try {
			const results = await launcher.run(payload.requests, {
				...payload.context,
				runId,
				deadlineAt: payload.deadlineAt,
				signal: controller.signal,
			});
			return results.map((raw) => {
				const result = relocateWorkspacePaths(raw, payload.workspaces);
				return {
					agent: result.agent,
					ok: result.ok,
					output: result.output,
					state: result.ok ? "done" : "failed",
					runId,
					...(result.outputPath ? { outputPath: result.outputPath } : {}),
					...(result.conversationId ? { conversationId: result.conversationId } : {}),
					...(result.error ? { error: result.error } : {}),
					...(result.failure ? { failure: result.failure } : {}),
				};
			});
		} finally {
			if (controller.signal.reason !== DURABLE_PAUSE_REASON) await releaseNightWorkspaces(payload.workspaces);
		}
	})();
	return { promise, cancel: () => controller.abort(), pause: () => controller.abort(DURABLE_PAUSE_REASON) };
}

interface Slot {
	entry: Promise<DurableSupervisor>;
	closing?: Promise<void>;
}
const SUPERVISORS = Symbol.for("babariviere.pi-extensions.durable-supervisors.v2");
function supervisors(): Map<string, Slot> {
	const state = globalThis as typeof globalThis & { [key: symbol]: Map<string, Slot> | undefined };
	return (state[SUPERVISORS] ??= new Map());
}

export async function acquireDurableSupervisor(
	ref: SessionRef,
	backend: RunBackend = runConversationBatch,
): Promise<DurableSupervisor> {
	const key = durableDirectory(ref);
	const entries = supervisors();
	const existing = entries.get(key);
	if (existing?.closing) {
		await existing.closing;
		return acquireDurableSupervisor(ref, backend);
	}
	if (existing) {
		const active = await existing.entry;
		if (existing.closing || entries.get(key) !== existing) return acquireDurableSupervisor(ref, backend);
		active.launcher.replace(backend);
		return active;
	}
	const slot: Slot = { entry: DurableSupervisor.open(key, backend) };
	entries.set(key, slot);
	try {
		const active = await slot.entry;
		if (slot.closing || entries.get(key) !== slot) return acquireDurableSupervisor(ref, backend);
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
