/** Process-local owners survive extension reloads; SQLite records survive process restarts. */
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { JobsProvider, type AnnouncementTiming } from "./jobs-provider.ts";
import { JobsStorage } from "./job-storage.ts";

export interface JobsSession {
	sessionId: string;
	sessionFile?: string;
	cwd: string;
}

export function jobsDirectory(ref: JobsSession): string | undefined {
	if (!ref.sessionFile) return undefined;
	const identity = createHash("sha256").update(ref.sessionId).digest("hex").slice(0, 24);
	const file = resolve(ref.sessionFile);
	// Session files may not have been flushed yet, but their directory exists.
	const canonical = join(realpathSync(dirname(file)), basename(file));
	return resolve(`${canonical}.jobs`, identity);
}

interface Slot {
	provider: JobsProvider;
	closing?: Promise<void>;
}
const OWNERS = Symbol.for("babariviere.pi-extensions.jobs-owners.v1");
function owners(): Map<string, Slot> {
	const state = globalThis as typeof globalThis & { [key: symbol]: Map<string, Slot> | undefined };
	return (state[OWNERS] ??= new Map());
}
function key(ref: JobsSession): string {
	return jobsDirectory(ref) ?? `memory:${JSON.stringify([ref.cwd, ref.sessionId])}`;
}

export async function acquireJobs(
	ref: JobsSession,
	timing: Partial<AnnouncementTiming>,
	isCurrent = () => true,
): Promise<JobsProvider> {
	if (!isCurrent()) throw new Error("Jobs startup was superseded");
	const entries = owners();
	const identity = key(ref);
	const existing = entries.get(identity);
	if (existing?.closing) {
		await existing.closing;
		return acquireJobs(ref, timing, isCurrent);
	}
	if (existing) return existing.provider;
	const directory = jobsDirectory(ref);
	const storage = directory ? JobsStorage.open(directory) : undefined;
	try {
		const provider = new JobsProvider(
			async () => {
				throw new Error("Jobs runtime is detached");
			},
			() => {},
			() => false,
			undefined,
			timing,
			storage,
		);
		provider.suspend();
		entries.set(identity, { provider });
		return provider;
	} catch (error) {
		storage?.close();
		throw error;
	}
}

export async function closeJobs(ref: JobsSession): Promise<void> {
	const entries = owners();
	const identity = key(ref);
	const slot = entries.get(identity);
	if (!slot) return;
	return (slot.closing ??= (async () => {
		try {
			await slot.provider.close();
		} finally {
			if (entries.get(identity) === slot) entries.delete(identity);
		}
	})());
}
