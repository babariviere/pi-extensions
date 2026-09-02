import assert from "node:assert/strict";
import { test } from "node:test";

import type { CapturedToolCatalog, CapturedToolEntry } from "../capture/catalog.ts";
import { coreOverridePromptGuidance } from "./core-override-guidance.ts";

const catalogWith = (
	tools: Array<{ name: string; promptSnippet?: string; promptGuidelines?: string[] }>,
): Pick<CapturedToolCatalog, "get"> => {
	const entries = new Map(
		tools.map((tool) => [tool.name, { name: tool.name, definition: tool } as unknown as CapturedToolEntry]),
	);
	return { get: (name: string) => entries.get(name) };
};

test("a catalog without core overrides contributes nothing", () => {
	assert.equal(coreOverridePromptGuidance(catalogWith([{ name: "web_search", promptSnippet: "search" }])), "");
});

test("an override's authored guidance is surfaced under its pi name", () => {
	const guidance = coreOverridePromptGuidance(
		catalogWith([{ name: "bash", promptSnippet: "use jj, never git", promptGuidelines: ["prefer rg over grep"] }]),
	);
	assert.match(guidance, /Additional guidance for `pi\.bash`: use jj, never git/);
	assert.match(guidance, /- prefer rg over grep/);
});

test("an override without prompt text contributes nothing", () => {
	assert.equal(coreOverridePromptGuidance(catalogWith([{ name: "bash" }])), "");
});
