/**
 * Spindle's `pi.bash` tool definition.
 *
 * Wraps pi's bash tool with three per-call extras the sandboxed guest can
 * pass alongside `command`:
 *
 * - `cwd`: absolute working directory for this one command
 * - `env`: extra variables merged over the shell environment
 * - `stdin`: text piped to the command (replaces quoting tricks such as
 *   `printf ... | ssh host bash -s`)
 *
 * The extras never reach pi's own tool schema: the wrapper validates them,
 * builds a per-call tool instance whose `BashOperations` applies them, and
 * runs that. Per-call construction keeps every invocation independent, so
 * concurrent `Promise.all` bash calls cannot race on shared state. The
 * extras-free path delegates to the shared base tool unchanged.
 *
 * `stdin` needs a spindle-owned spawn: both exec paths pi provides use
 * `stdio: ["ignore", ...]`. The stdin path delegates to the shared supervised
 * spawn (`sandbox/supervised-spawn.ts`, also the OS-sandbox wrap's backend),
 * so pi's tool-level error formatting still applies, and it routes the command
 * through the OS-sandbox wrap when one is active.
 */

import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
	createBashToolDefinition,
	createLocalBashOperations,
	type BashOperations,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { supervisedSpawn } from "../sandbox/supervised-spawn.ts";
import { Type } from "typebox";

export const MAX_STDIN_CHARS = 8 * 1024 * 1024;

export interface SpindleBashSandbox {
	/** Late-bound (policy-aware) operations, normally the sandbox controller's. */
	operations?: BashOperations;
	/** Wrap a command for the OS sandbox when one is active; identity otherwise. */
	wrapCommand?: (command: string) => Promise<string>;
}

const spindleBashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
	cwd: Type.Optional(Type.String({ description: "Absolute working directory for this command" })),
	env: Type.Optional(
		Type.Record(Type.String(), Type.String(), {
			description: "Extra environment variables, merged over the shell environment",
		}),
	),
	stdin: Type.Optional(Type.String({ description: "Text piped to the command's stdin" })),
});

const SKIPPED_ENV_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export const createSpindleBashToolDefinition = (
	cwd: string,
	sandbox: SpindleBashSandbox = {},
): ToolDefinition<any, any, any> => {
	const base = createBashToolDefinition(cwd, sandbox.operations ? { operations: sandbox.operations } : undefined);
	const inner = sandbox.operations ?? createLocalBashOperations();
	const wrapCommand = sandbox.wrapCommand ?? ((command: string) => Promise.resolve(command));

	return {
		name: "bash",
		label: base.label,
		description:
			`${base.description} Optional per-call extras: cwd (absolute working directory for this command), ` +
			"env (extra variables merged over the shell environment), and stdin (text piped to the " +
			"command, e.g. pi.bash({ command: 'ssh host bash -s', stdin: script })).",
		promptSnippet: base.promptSnippet,
		promptGuidelines: base.promptGuidelines,
		parameters: spindleBashSchema,
		async execute(toolCallId, args, signal, onUpdate, ctx) {
			const callArgs = args as {
				command: string;
				timeout?: number;
				cwd?: string;
				env?: Record<string, string>;
				stdin?: string;
			};
			const { command, timeout, cwd: callCwd, env: callEnv, stdin: callStdin } = callArgs;
			if (callCwd === undefined && callEnv === undefined && callStdin === undefined) {
				return base.execute(toolCallId, callArgs, signal, onUpdate, ctx);
			}

			if (callCwd !== undefined) {
				if (typeof callCwd !== "string" || !isAbsolute(callCwd)) {
					throw new Error(`pi.bash cwd must be an absolute path (got: ${JSON.stringify(callCwd)})`);
				}
				const info = await stat(callCwd).catch(() => undefined);
				if (info === undefined || !info.isDirectory()) {
					throw new Error(`pi.bash cwd is not an existing directory: ${callCwd}`);
				}
			}

			let mergedCallEnv: Record<string, string> | undefined;
			if (callEnv !== undefined && callEnv !== null && typeof callEnv === "object") {
				mergedCallEnv = {};
				for (const [key, value] of Object.entries(callEnv)) {
					if (SKIPPED_ENV_KEYS.has(key)) continue;
					if (typeof value !== "string") {
						throw new Error(`pi.bash env values must be strings (${key} is ${typeof value})`);
					}
					mergedCallEnv[key] = value;
				}
			}

			if (callStdin !== undefined && callStdin.length > MAX_STDIN_CHARS) {
				throw new Error(`pi.bash stdin is ${callStdin.length} chars; the limit is ${MAX_STDIN_CHARS}`);
			}

			const operations: BashOperations = {
				exec: async (innerCommand, defaultCwd, options) => {
					const effectiveCwd = callCwd ?? defaultCwd;
					const env = mergedCallEnv !== undefined ? { ...(options.env ?? {}), ...mergedCallEnv } : options.env;
					if (callStdin === undefined) {
						return inner.exec(innerCommand, effectiveCwd, { ...options, env });
					}
					const command = await wrapCommand(innerCommand);
					return supervisedSpawn({
						command,
						cwd: effectiveCwd,
						onData: options.onData,
						...(options.signal ? { signal: options.signal } : {}),
						...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
						...(env ? { env } : {}),
						stdin: callStdin,
					});
				},
			};
			const perCall = createBashToolDefinition(cwd, { operations });
			return perCall.execute(toolCallId, { command, timeout }, signal, onUpdate, ctx);
		},
	};
};
