/**
 * Child-side task delivery: the first user message of a subagent's `pi`.
 *
 * The parent writes the framed task to a file and points the child at it with
 * `--{@link TASK_FILE_FLAG}`; here (inside the child) that file becomes an
 * actual user message via `pi.sendUserMessage`, which always triggers a turn.
 *
 * Why not type it into the pane: `herdr agent prompt` writes to pi's tty, and
 * anything that lands before the TUI binds its input handler is discarded, so a
 * slow child (a fresh night jj workspace, extension load, MCP connect) came up
 * idle with an empty composer and the run died at its timeout. Injecting from
 * inside pi has no such window - the runtime is up by definition.
 *
 * Delivery happens once, on the `startup` session only: a `/new`, `/resume`,
 * `fork` or reload later in the same process must not re-send the task.
 */

import { readFileSync } from "node:fs";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { TASK_FILE_FLAG } from "./constants.ts";

/**
 * Register the task-file flag. Called unconditionally by Spindle's entry point,
 * so every child accepts the flag without an injected `--extension`, and pi
 * never sees it registered twice (the child extension registers only the
 * sandbox flag).
 */
export function registerTaskFileFlag(pi: ExtensionAPI): void {
	pi.registerFlag(TASK_FILE_FLAG, {
		type: "string",
		description: "Path to a file whose contents are delivered as this run's first user message (set by the parent).",
	});
}

/** Read a task file, treating a missing or blank file as no task. */
export function readTaskFile(
	path: string,
	read: (p: string) => string = (p) => readFileSync(p, "utf-8"),
): string | undefined {
	try {
		const text = read(path);
		return text.trim().length > 0 ? text : undefined;
	} catch {
		return undefined;
	}
}

/** The `session_start` reasons pi reports; only `startup` carries the task. */
export function isInitialSession(reason: string | undefined): boolean {
	return reason === "startup";
}

export interface TaskDeliveryDeps {
	/** The flag value, or undefined when this process was not given a task. */
	taskFile: () => string | undefined;
	/** Injects the task as a user message (production: `pi.sendUserMessage`). */
	send: (text: string) => void;
	/** Reads the task file. Defaults to {@link readTaskFile}. */
	read?: (path: string) => string | undefined;
	/** Reports a task that was promised but could not be read. */
	onError?: (message: string) => void;
}

/**
 * Build the `session_start` hook that delivers the task, closing over its
 * once-only state. Split from the wiring below so the ordering rules (once,
 * startup only, no flag = no-op) are unit-testable without a pi host.
 */
export function createTaskDeliverer(deps: TaskDeliveryDeps): (reason: string | undefined) => void {
	let delivered = false;
	return (reason) => {
		if (delivered || !isInitialSession(reason)) return;
		const path = deps.taskFile()?.trim();
		if (!path) return;
		// Claimed before reading: an unreadable task is reported once, not retried
		// on the next session_start.
		delivered = true;
		const task = (deps.read ?? readTaskFile)(path);
		if (task === undefined) {
			deps.onError?.(`[spindle] task file is missing or empty, the subagent has no task: ${path}`);
			return;
		}
		deps.send(task);
	};
}

/** Production deliverer bound to a pi extension host. */
export function taskDeliveryFor(pi: ExtensionAPI): (reason: string | undefined) => void {
	return createTaskDeliverer({
		taskFile: () => {
			const value = pi.getFlag(TASK_FILE_FLAG);
			return typeof value === "string" ? value : undefined;
		},
		send: (text) => pi.sendUserMessage(text),
		onError: (message) => console.warn(message),
	});
}
