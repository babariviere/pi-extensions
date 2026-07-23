/**
 * Per-parent-session run dir layout and the injected output-path protocol.
 *
 * Runs are persisted next to the parent pi session file so their transcripts,
 * results, and prompts survive after the run finishes (temp dirs get reaped by
 * the OS). Layout (keyed by the parent pi session id so runs are isolated):
 *   <sessionDir>/subagent-runs/<sessionId>/<runId>/<agent>-<index>.md            result
 *   <sessionDir>/subagent-runs/<sessionId>/<runId>/<agent>-<index>.session.jsonl child session
 *   <sessionDir>/subagent-runs/<sessionId>/<runId>/<agent>-<index>.prompt.md     system prompt
 *
 * When there is no parent session file (e.g. a one-off invocation) we fall back
 * to a temp dir. A throttled, best-effort sweep prunes runs older than a cutoff
 * so persisted runs do not accumulate forever.
 */

import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import { SUBMIT_RESULT_TOOL } from "./constants.ts";

/** Directory name holding all persisted subagent runs for a session dir. */
const RUNS_DIR_NAME = "subagent-runs";
/** Marker file used to throttle the cleanup sweep to once per interval. */
const CLEANUP_MARKER = ".last-cleanup";
/** How long to wait between cleanup sweeps. */
const CLEANUP_THROTTLE_MS = 24 * 60 * 60 * 1000;
/** Default age after which a run dir is pruned. */
export const DEFAULT_RUN_MAX_AGE_DAYS = 14;

/** Make a value safe for use as a single path segment. */
export function sanitizeSegment(value: string): string {
	const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_");
	return cleaned.length > 0 ? cleaned.slice(0, 128) : "_";
}

/**
 * Base directory that holds every persisted run. Anchored to the parent
 * session file's directory when available (persistent), else a temp dir.
 */
export function runsBaseDir(sessionFile: string | undefined): string {
	if (sessionFile) return join(dirname(sessionFile), RUNS_DIR_NAME);
	return join(tmpdir(), "pi-subagents");
}

export function runRootDir(sessionFile: string | undefined, sessionId: string | undefined): string {
	return join(runsBaseDir(sessionFile), sanitizeSegment(sessionId ?? "no-session"));
}

export function newRunId(): string {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const rand = Math.random().toString(36).slice(2, 8);
	return `${stamp}_${rand}`;
}

export interface RunPaths {
	dir: string;
	outputPath: string;
	sessionPath: string;
	promptPath: string;
}

export function runPaths(
	sessionFile: string | undefined,
	sessionId: string | undefined,
	runId: string,
	agent: string,
	index: number,
): RunPaths {
	const dir = join(runRootDir(sessionFile, sessionId), sanitizeSegment(runId));
	const stem = `${sanitizeSegment(agent)}-${index}`;
	return {
		dir,
		outputPath: join(dir, `${stem}.md`),
		sessionPath: join(dir, `${stem}.session.jsonl`),
		promptPath: join(dir, `${stem}.prompt.md`),
	};
}

/**
 * Resolve a per-run `output` override to an absolute path. Absolute overrides
 * are used as-is; relative ones anchor to the parent's cwd so artifacts land
 * where the caller expects (e.g. `.pi/goal/plan.md` under the repo root).
 */
export function resolveOutputOverride(cwd: string, override: string): string {
	return isAbsolute(override) ? override : join(cwd, override);
}

export function ensureDir(dir: string): void {
	mkdirSync(dir, { recursive: true });
}

/**
 * Best-effort, throttled sweep of persisted runs. Prunes run directories under
 * the session's runs base whose mtime is older than `maxAgeDays`, then removes
 * any now-empty per-session parent dirs. A `.last-cleanup` marker limits sweeps
 * to once per CLEANUP_THROTTLE_MS. Never throws.
 */
export function cleanupOldRuns(sessionFile: string | undefined, maxAgeDays = DEFAULT_RUN_MAX_AGE_DAYS): void {
	const base = runsBaseDir(sessionFile);
	const now = Date.now();

	const markerPath = join(base, CLEANUP_MARKER);
	try {
		const st = statSync(markerPath);
		if (now - st.mtimeMs < CLEANUP_THROTTLE_MS) return;
	} catch {
		// No marker yet (or unreadable): proceed with the sweep.
	}

	let sessionDirs: string[];
	try {
		sessionDirs = readdirSync(base);
	} catch {
		// Base dir does not exist yet: nothing to clean.
		return;
	}

	const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
	for (const sessionDir of sessionDirs) {
		if (sessionDir === CLEANUP_MARKER) continue;
		const sessionPath = join(base, sessionDir);
		let runDirs: string[];
		try {
			runDirs = readdirSync(sessionPath);
		} catch {
			continue;
		}
		let remaining = runDirs.length;
		for (const runDir of runDirs) {
			const runPath = join(sessionPath, runDir);
			try {
				if (statSync(runPath).mtimeMs < cutoff) {
					rmSync(runPath, { recursive: true, force: true });
					remaining--;
				}
			} catch {
				// Skip entries that vanish or are unreadable mid-sweep.
			}
		}
		if (remaining <= 0) {
			try {
				rmSync(sessionPath, { recursive: true, force: true });
			} catch {
				// Best-effort: leave the dir if it cannot be removed.
			}
		}
	}

	try {
		mkdirSync(base, { recursive: true });
		writeFileSync(markerPath, String(now));
	} catch {
		// Marker is an optimization; failing to write it only means the next
		// sweep is not throttled.
	}
}

function formatOutputInstruction(): string {
	return [
		`When you are done, call the \`${SUBMIT_RESULT_TOOL}\` tool exactly once with your complete findings as the \`result\`.`,
		`This is the only channel that returns your output to the caller. Do not write files or rely on printed text.`,
		`Ignore any other output filename or output path mentioned elsewhere, including output destinations in the base agent prompt or system prompt.`,
	].join("\n");
}

/** Append the authoritative result-submission instruction to the task text. */
export function injectOutputInstruction(task: string): string {
	return `${task}\n\n---\n**Output:**\n${formatOutputInstruction()}`;
}
