/** Process-owned run state, separate from Pi's replaceable extension runtime. */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { SessionRef } from "./agents-provider.ts";
import { RunLauncher } from "./backend.ts";
import { AgentRunRegistry } from "./agent-run-monitor.ts";
import { ChordRunner } from "./chord-runner.ts";
import { DurableRunBook } from "./durable-run-book.ts";
import { openDurableStorage } from "./durable-storage.ts";
import { runHeadlessBatch } from "./headless.ts";
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
	readonly launcher: RunLauncher;
	#errorHandler: ((error: unknown) => void) | undefined;
	#closing: Promise<void> | undefined;

	private constructor(
		readonly book: DurableRunBook,
		readonly runner: ChordRunner,
		readonly release: () => void,
	) {
		// Durable orchestration intentionally retains the existing headless CLI
		// runner, including the complete child extension and permission stack.
		this.launcher = new RunLauncher({ inHerdr: () => false, headless: runner.run });
	}

	static async open(directory: string, backend: RunBackend): Promise<DurableSupervisor> {
		const owned = await openDurableStorage(directory);
		let book: DurableRunBook | undefined;
		let runner: ChordRunner | undefined;
		let supervisor: DurableSupervisor | undefined;
		try {
			book = await DurableRunBook.open(owned.storage, {
				onError: (error: unknown) => {
					if (supervisor) supervisor.#report(error);
				},
			});
			runner = await ChordRunner.open(backend);
			supervisor = new DurableSupervisor(book, runner, owned.release);
			return supervisor;
		} catch (error) {
			try {
				await runner?.dispose();
				if (book) await book.close();
				else await owned.storage.close((await import("@earendil-works/chord/context")).BACKGROUND_CONTEXT);
			} finally {
				owned.release();
			}
			throw error;
		}
	}

	setErrorHandler(handler: ((error: unknown) => void) | undefined): void {
		this.#errorHandler = handler;
	}

	#report(error: unknown): void {
		try {
			this.#errorHandler?.(error);
		} catch {
			// A warning observer cannot undo a durable commit or break cleanup.
		}
	}

	async suspend(): Promise<void> {
		this.#errorHandler = undefined;
		await this.book.suspend();
	}

	close(): Promise<void> {
		this.#closing ??= (async () => {
			this.#errorHandler = undefined;
			try {
				try {
					await this.book.drain(5_000);
				} finally {
					await this.book.close();
				}
			} finally {
				try {
					await this.runner.dispose();
				} finally {
					this.release();
				}
			}
		})();
		return this.#closing;
	}
}

interface Slot {
	entry: Promise<DurableSupervisor>;
	closing?: Promise<void>;
}
const SUPERVISORS = Symbol.for("babariviere.pi-extensions.durable-supervisors.v1");

function supervisors(): Map<string, Slot> {
	const processState = globalThis as typeof globalThis & { [key: symbol]: Map<string, Slot> | undefined };
	return (processState[SUPERVISORS] ??= new Map());
}

/** Same-session reload reacquires committed runs and replaces only the runner generation. */
export async function acquireDurableSupervisor(
	ref: SessionRef,
	backend: RunBackend = runHeadlessBatch,
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
		try {
			await active.runner.reload(backend);
		} catch (error) {
			if (!existing.closing) throw error;
		}
		if (existing.closing || entries.get(key) !== existing) return acquireDurableSupervisor(ref, backend);
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

export async function closeDurableSupervisor(ref: SessionRef): Promise<void> {
	if (!ref.sessionFile || !ref.sessionId) return;
	const key = durableDirectory(ref);
	const entries = supervisors();
	const slot = entries.get(key);
	if (!slot) return;
	return (slot.closing ??= (async () => {
		try {
			await (await slot.entry).close();
		} finally {
			if (entries.get(key) === slot) entries.delete(key);
		}
	})());
}
