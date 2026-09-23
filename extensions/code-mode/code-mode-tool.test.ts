import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { createCodeModeExecTool } from "./code-mode-tool.ts";
import type { CodeModeState } from "./code-mode-state.ts";
import { defaultCodePreviewSettings } from "./ui/code-preview.ts";

test("the tool call block shows its objective below the title without changing code line numbers", () => {
	const tool = createCodeModeExecTool({} as CodeModeState, defaultCodePreviewSettings(), (definition) => definition);
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
	const render = (display: unknown): string[] =>
		tool.renderCall!({ code: "return 1;", display }, theme, {
			state: {},
			isPartial: false,
			executionStarted: true,
			expanded: false,
			cwd: process.cwd(),
			invalidate: () => {},
		} as never)
			.render(120)
			.map((line) => line.trimEnd());
	assert.deepEqual(render({ name: "Check TUI", description: "Inspect   widget\n rows" }), [
		"Code Mode Check TUI TypeScript · 1 line",
		"Objective: Inspect widget rows",
		"1 return 1;",
	]);
	assert.equal(
		render({ name: "Check TUI" }).some((line) => line.startsWith("Objective:")),
		false,
	);
});
