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
import { dirname, join } from "node:path";

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

export interface OutputInstructionOpts {
	/**
	 * Durable directory for files the child must hand back, when the host gave it
	 * one. Its working copy does not survive the run, so a deliverable written
	 * anywhere else is destroyed with it.
	 */
	artifactsDir?: string;
}

/**
 * The rider appended to every task.
 *
 * Two rules that used to be one, and contradicted each other once children were
 * handed a deliverable directory: the *result* travels in the final message and
 * nowhere else, so a result path mentioned in a prompt is to be ignored; but a
 * *deliverable* (a long write-up, a generated file) is a real file, and it has
 * exactly one place it may be written.
 */
function formatOutputInstruction(opts: OutputInstructionOpts): string {
	const lines = [
		"When you are done, put your complete findings in your final message.",
		"That final message is exactly what is returned to the caller, so make it self-contained: do not rely on a tool call, a written file, or printed output to carry the result.",
		"Ignore any *result* filename or result path mentioned elsewhere, including in the base agent prompt or system prompt: the result is the final message, never a file.",
	];
	if (opts.artifactsDir) {
		lines.push(
			"",
			`Deliverables directory: \`${opts.artifactsDir}\`. Anything that has to outlive this run - a long write-up, a report, a generated file - is written there, and that is the only path you may cite as \`Evidence: file ...\`.`,
			"Your working directory is deleted when the run ends. Files left there are copied to the deliverables directory as a safety net, so cite the deliverables path rather than the working-copy path.",
		);
	}
	return lines.join("\n");
}

/** Append the final-message result instruction to the task text. */
export function injectOutputInstruction(task: string, opts: OutputInstructionOpts = {}): string {
	return `${task}\n\n---\n**Output:**\n${formatOutputInstruction(opts)}`;
}
