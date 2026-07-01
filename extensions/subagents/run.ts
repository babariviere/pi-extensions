/**
 * Shared run types and output-file reading helpers used by both backends.
 */

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { ensureDir } from "./paths.ts";
import { type DiscoveredAgent } from "./discovery.ts";

export interface RunRequest {
	agent: DiscoveredAgent;
	task: string;
	index: number;
}

/** Live lifecycle state of a single run, surfaced to the in-progress indicator. */
export type RunState = "spawning" | "running" | "done" | "failed";

export interface RunStatusUpdate {
	state: RunState;
	paneId?: string;
	outputPath?: string;
}

/**
 * Optional callback both backends invoke on lifecycle transitions so the tool
 * can stream a compact live indicator. `index` matches `RunRequest.index`.
 */
export type OnStatus = (index: number, update: RunStatusUpdate) => void;

export interface RunResult {
	agent: string;
	scope: string;
	ok: boolean;
	output: string;
	outputPath: string;
	/** Populated for the headless backend; undefined for herdr panes. */
	exitCode?: number;
	/** Populated for herdr runs. */
	paneId?: string;
	error?: string;
}

/** Write the agent's system-prompt body to disk so `pi` can load it. */
export function writeSystemPrompt(promptPath: string, body: string): void {
	writeFileSync(promptPath, body, { mode: 0o600 });
}

export function ensureRunDir(dir: string): void {
	ensureDir(dir);
}

interface Snapshot {
	exists: boolean;
	size: number;
	mtimeMs: number;
}

function snapshot(path: string): Snapshot {
	try {
		const st = statSync(path);
		return { exists: true, size: st.size, mtimeMs: st.mtimeMs };
	} catch {
		return { exists: false, size: 0, mtimeMs: 0 };
	}
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Poll until the output file exists and is stable (unchanged size+mtime across
 * one interval), or the overall timeout elapses. Returns whether it stabilized.
 */
export async function waitForStableFile(
	path: string,
	opts: { timeoutMs: number; intervalMs?: number; isDone?: () => boolean },
): Promise<boolean> {
	const interval = opts.intervalMs ?? 400;
	const deadline = Date.now() + opts.timeoutMs;
	let prev = snapshot(path);
	while (Date.now() < deadline) {
		await sleep(interval);
		const cur = snapshot(path);
		if (cur.exists && prev.exists && cur.size === prev.size && cur.mtimeMs === prev.mtimeMs && cur.size > 0) {
			return true;
		}
		// If the pane reports done and the file already exists, accept it.
		if (cur.exists && cur.size > 0 && opts.isDone?.()) {
			return true;
		}
		prev = cur;
	}
	return snapshot(path).exists;
}

export function readOutputFile(path: string): string | undefined {
	try {
		const text = readFileSync(path, "utf-8");
		return text.length > 0 ? text : undefined;
	} catch {
		return undefined;
	}
}
