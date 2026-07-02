/**
 * Per-parent-session temp dir layout and the injected output-path protocol.
 *
 * Layout (keyed by the parent pi session id so runs are isolated per session):
 *   <tmp>/pi-subagents/<sessionId>/<runId>/<agent>-<index>.md            result
 *   <tmp>/pi-subagents/<sessionId>/<runId>/<agent>-<index>.session.jsonl child session
 *   <tmp>/pi-subagents/<sessionId>/<runId>/<agent>-<index>.prompt.md     system prompt
 */

import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SUBMIT_RESULT_TOOL } from "./constants.ts";

/** Make a value safe for use as a single path segment. */
export function sanitizeSegment(value: string): string {
	const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_");
	return cleaned.length > 0 ? cleaned.slice(0, 128) : "_";
}

export function runRootDir(sessionId: string | undefined): string {
	return join(tmpdir(), "pi-subagents", sanitizeSegment(sessionId ?? "no-session"));
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
	launchPath: string;
}

export function runPaths(sessionId: string | undefined, runId: string, agent: string, index: number): RunPaths {
	const dir = join(runRootDir(sessionId), sanitizeSegment(runId));
	const stem = `${sanitizeSegment(agent)}-${index}`;
	return {
		dir,
		outputPath: join(dir, `${stem}.md`),
		sessionPath: join(dir, `${stem}.session.jsonl`),
		promptPath: join(dir, `${stem}.prompt.md`),
		launchPath: join(dir, `${stem}.launch.sh`),
	};
}

export function ensureDir(dir: string): void {
	mkdirSync(dir, { recursive: true });
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
