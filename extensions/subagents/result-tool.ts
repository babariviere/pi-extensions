/**
 * Child-side result tool, loaded into each subagent's `pi` process via `-e`.
 *
 * Subagents can't be assumed to have `write`/`bash` (e.g. a read-only librarian),
 * so instead of asking the agent to write a file we give it a `submit_result`
 * tool. The tool runs in the child pi's own process, so it has fs access
 * regardless of the agent's `tools:` allowlist, and writes the result to the
 * path the parent passed via the `--{@link OUTPUT_PATH_FLAG}` CLI flag. The
 * agent never sees the path; it just calls the tool once with its findings.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { OUTPUT_PATH_FLAG, SUBMIT_RESULT_TOOL } from "./constants.ts";

function text(body: string) {
	return { content: [{ type: "text" as const, text: body }], details: undefined };
}

export const submitResultTool = defineTool({
	name: SUBMIT_RESULT_TOOL,
	label: SUBMIT_RESULT_TOOL,
	description:
		"Submit your final result back to the caller. Call this exactly once, as your last action, " +
		"with your complete findings as the `result`. This is the only channel that returns your output; " +
		"do not write files or rely on printed text.",
	promptSnippet: "Submit the subagent's final result to the caller",
	parameters: Type.Object({
		result: Type.String({ description: "Your complete final result to return to the caller." }),
	}),
	async execute(_toolCallId, params) {
		const outputPath = resolveOutputPath();
		if (!outputPath) {
			return text(`Cannot submit result: --${OUTPUT_PATH_FLAG} was not provided to this process.`);
		}
		try {
			mkdirSync(dirname(outputPath), { recursive: true });
			writeFileSync(outputPath, params.result, { encoding: "utf-8", mode: 0o600 });
		} catch (err) {
			return text(`Failed to write result: ${(err as Error).message}`);
		}
		return text("Result submitted to the caller.");
	},
});

/**
 * The output path resolves from the `--subagent-output-path` flag. `getFlag` is
 * only available after registration in the default export, so we capture the pi
 * API there and read the flag lazily at tool-execution time.
 */
let flagReader: (() => string | undefined) | undefined;

function resolveOutputPath(): string | undefined {
	const value = flagReader?.();
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag(OUTPUT_PATH_FLAG, {
		type: "string",
		description: "Path the submit_result tool writes the subagent's result to (set by the parent).",
	});
	flagReader = () => {
		const value = pi.getFlag(OUTPUT_PATH_FLAG);
		return typeof value === "string" ? value : undefined;
	};
	pi.registerTool(submitResultTool);
}
