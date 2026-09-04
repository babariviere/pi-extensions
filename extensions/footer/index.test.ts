import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderUsageLine } from "./index.ts";

const plainTheme = {
	fg: (_color: unknown, text: string) => text,
} as Theme;

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

test("renders Codex in blue with its weekly reset", () => {
	const resetsAt = new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString();
	const rendered = renderUsageLine(
		{
			provider: "openai",
			windows: [{ label: "Week", usedPercent: 12, resetsAt }],
		},
		plainTheme,
	);

	assert.match(rendered, /^\x1b\[38;2;59;130;246mCodex\x1b\[0m /);
	assert.match(stripAnsi(rendered), /Week .* 12% ⟳ Week 7d0h$/);
});
