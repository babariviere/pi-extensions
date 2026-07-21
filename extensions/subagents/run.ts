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
	/**
	 * Per-run overrides of the agent's frontmatter, used to diversify parallel
	 * runs (e.g. run the same reviewer on Opus and Sonnet to decorrelate errors).
	 * Undefined fields fall back to the agent config.
	 */
	overrides?: { model?: string; thinking?: string };
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

function isStable(a: Snapshot, b: Snapshot): boolean {
	return a.exists && b.exists && a.size === b.size && a.mtimeMs === b.mtimeMs && b.size > 0;
}

/**
 * Why a run finished waiting:
 * - `stable`   the output file appeared and stopped changing (success path)
 * - `finished` the agent went idle/exited without producing a stable file
 * - `gone`     the pane vanished (e.g. the user terminated the subagent)
 * - `timeout`  none of the above happened before the deadline
 */
export type RunOutcome = "stable" | "finished" | "gone" | "timeout";

/**
 * Wait for a run to complete by racing two signals: the output file becoming
 * stable (polled cheaply via fs.stat), and an optional `agentSignal` promise
 * that resolves when the agent finishes (`finished`) or its pane is terminated
 * (`gone`). The agentSignal is expected to come from a blocking herdr wait, so
 * no process polling happens here.
 *
 * The file check is the success path. When the agent signal fires we still allow
 * a short grace window for a final write to land, preferring `stable` if it does.
 */
export async function waitForRunCompletion(
	path: string,
	opts: {
		timeoutMs: number;
		intervalMs?: number;
		graceMs?: number;
		agentSignal?: Promise<"finished" | "gone">;
	},
): Promise<RunOutcome> {
	const interval = opts.intervalMs ?? 400;
	const grace = opts.graceMs ?? 2500;
	const deadline = Date.now() + opts.timeoutMs;

	let signal: "finished" | "gone" | undefined;
	opts.agentSignal?.then((s) => {
		signal = s;
	}).catch(() => {});

	let prev = snapshot(path);
	while (Date.now() < deadline) {
		await sleep(interval);
		const cur = snapshot(path);
		if (isStable(prev, cur)) return "stable";
		prev = cur;

		if (signal) {
			// Grace: give a final write a chance to land before finalizing.
			const graceDeadline = Math.min(deadline, Date.now() + grace);
			let gp = snapshot(path);
			while (Date.now() < graceDeadline) {
				await sleep(interval);
				const gc = snapshot(path);
				if (isStable(gp, gc)) return "stable";
				gp = gc;
			}
			return signal;
		}
	}
	return "timeout";
}

export function readOutputFile(path: string): string | undefined {
	try {
		const text = readFileSync(path, "utf-8");
		return text.length > 0 ? text : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Recover a run's result from the child pi session transcript when the output
 * file is missing. Agents sometimes end their turn with a plain assistant
 * message instead of calling the submit_result tool (reviewers are especially
 * prone to this), which leaves a complete answer on disk but no output file.
 * Returns the concatenated text of the last assistant message, or undefined
 * when the transcript is unreadable or has no assistant text.
 */
export function readLastAssistantText(sessionPath: string): string | undefined {
	let raw: string;
	try {
		raw = readFileSync(sessionPath, "utf-8");
	} catch {
		return undefined;
	}
	let last: string | undefined;
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) continue;
		let obj: unknown;
		try {
			obj = JSON.parse(trimmed);
		} catch {
			continue;
		}
		const msg = (obj as { message?: { role?: unknown; content?: unknown } }).message;
		if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		const text = msg.content
			.filter(
				(c): c is { type: string; text: string } =>
					!!c &&
					typeof c === "object" &&
					(c as { type?: unknown }).type === "text" &&
					typeof (c as { text?: unknown }).text === "string",
			)
			.map((c) => c.text)
			.join("")
			.trim();
		if (text.length > 0) last = text;
	}
	return last;
}
