/** Model-name compatibility and durable task framing. */

import { buildNightContract, readActiveNightRun } from "../night-mode/night-run.ts";
import { injectOutputInstruction } from "./paths.ts";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

/** Strip a trailing `:thinking` suffix from a model id, if one is present. */
export function stripThinkingSuffix(model: string): string {
	const colonIdx = model.lastIndexOf(":");
	if (colonIdx !== -1 && THINKING_LEVELS.includes(model.substring(colonIdx + 1))) {
		return model.substring(0, colonIdx);
	}
	return model;
}

/** Extract a trailing `:thinking` suffix from a model id, if one is present. */
export function extractThinkingSuffix(model: string): string | undefined {
	const colonIdx = model.lastIndexOf(":");
	if (colonIdx !== -1 && THINKING_LEVELS.includes(model.substring(colonIdx + 1))) {
		return model.substring(colonIdx + 1);
	}
	return undefined;
}

/**
 * Qualify a bare model name with the default provider so pi routes it to the
 * intended provider. Already-qualified (`provider/model`), empty, or
 * provider-less-config models are returned unchanged.
 */
export function qualifyModel(model: string | undefined, defaultProvider: string | undefined): string | undefined {
	if (!model) return model;
	if (model.includes("/")) return model;
	if (!defaultProvider) return model;
	return `${defaultProvider}/${model}`;
}

/** Prepend a read-first instruction listing the context files, if any. */
function withReads(task: string, reads: string[] | undefined): string {
	if (!reads || reads.length === 0) return task;
	const list = reads.map((f) => `\`${f}\``).join(", ");
	return `Read these files first for context: ${list}.\n\n${task}`;
}

/**
 * Prepend the night-mode contract when the run opts into it and a night run is
 * actually in flight. Reading the handshake here (rather than passing the text
 * down) keeps the caller from having to know about night mode.
 */
function withNight(task: string, night: boolean | undefined, workspacePath?: string): string {
	if (!night) return task;
	const run = readActiveNightRun();
	return run ? `${buildNightContract(run, workspacePath)}\n${task}` : task;
}

/** What the task framing needs beyond the task itself. */
export interface TaskFraming {
	reads?: string[];
	night?: boolean;
	workspacePath?: string;
	artifactsDir?: string;
}

/** The task framing given to the child agent, with the final-message rider. */
export function formatTaskMessage(task: string, framing: TaskFraming = {}): string {
	const body = injectOutputInstruction(withReads(task, framing.reads), {
		...(framing.artifactsDir ? { artifactsDir: framing.artifactsDir } : {}),
	});
	return withNight(`Task: ${body}`, framing.night, framing.workspacePath);
}
