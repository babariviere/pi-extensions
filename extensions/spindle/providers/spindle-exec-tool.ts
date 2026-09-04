import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { supervisedSpawn } from "../sandbox/supervised-spawn.ts";

const schema = Type.Object({
	argv: Type.Array(Type.String(), { minItems: 1, description: "Program followed by its literal arguments" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds" })),
	cwd: Type.Optional(Type.String({ description: "Absolute working directory" })),
	env: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Extra environment variables" })),
	stdin: Type.Optional(Type.String({ description: "Text piped to stdin" })),
});

export interface SpindleExecSandbox {
	wrapArgv?: (argv: readonly string[]) => Promise<readonly string[]>;
}

export const createSpindleExecToolDefinition = (
	cwd: string,
	sandbox: SpindleExecSandbox = {},
): ToolDefinition<any, any, any> => ({
	name: "exec",
	label: "exec",
	description: "Execute a program with literal argv arguments, without shell parsing. Use bash for pipelines, redirects, glob expansion, or shell syntax.",
	parameters: schema,
	async execute(_toolCallId, args, signal, onUpdate) {
		const { argv, timeout, cwd: callCwd, env, stdin } = args as {
			argv: string[];
			timeout?: number;
			cwd?: string;
			env?: Record<string, string>;
			stdin?: string;
		};
		if (callCwd !== undefined) {
			if (!isAbsolute(callCwd)) throw new Error(`pi.exec cwd must be an absolute path (got: ${JSON.stringify(callCwd)})`);
			const info = await stat(callCwd).catch(() => undefined);
			if (!info?.isDirectory()) throw new Error(`pi.exec cwd is not an existing directory: ${callCwd}`);
		}
		const effectiveArgv = await (sandbox.wrapArgv ?? (async (value) => value))(argv);
		let output = "";
		const result = await supervisedSpawn({
			argv: effectiveArgv,
			cwd: callCwd ?? cwd,
			onData(data) {
				const text = data.toString();
				output += text;
				onUpdate?.({ content: [{ type: "text", text: output }], details: undefined });
			},
			...(timeout !== undefined ? { timeout } : {}),
			...(signal ? { signal } : {}),
			...(env ? { env } : {}),
			...(stdin !== undefined ? { stdin } : {}),
		});
		if (result.exitCode && result.exitCode !== 0) throw new Error(`${output}\n\nCommand exited with code ${result.exitCode}`);
		return { content: [{ type: "text", text: output || "(no output)" }], details: undefined };
	},
});
