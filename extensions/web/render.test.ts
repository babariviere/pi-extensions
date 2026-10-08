import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { createWebTool } from "./tool.ts";

const theme = {
	fg: (_color: string, value: string) => value,
	bold: (value: string) => value,
};

test("web retains action-specific call titles and reuses its Text component", () => {
	const tool = createWebTool();
	const search = tool.renderCall!({ action: "search", query: "fixture", limit: 3 }, theme as never, {} as never);
	assert.equal(search.render(120).join("\n").trimEnd(), "web search /fixture/ limit 3");
	const fetch = tool.renderCall!(
		{ action: "fetch", url: " https://example.com " },
		theme as never,
		{
			lastComponent: search,
		} as never,
	);
	assert.equal(fetch, search);
	assert.equal(fetch.render(120).join("\n").trimEnd(), "fetch content https://example.com");
	const invalid = tool.renderCall!({ action: "search" }, theme as never, {} as never);
	assert.match(invalid.render(120).join("\n"), /web search \[invalid arg\]/);
});

test("web retains folded previews, expansion, and human-only fetch source labels", () => {
	initTheme("dark", false);
	const tool = createWebTool();
	const body = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
	const result = { content: [{ type: "text" as const, text: body }], details: { source: "browser" as const } };
	const folded = tool.renderResult!(
		result,
		{ expanded: false, isPartial: false },
		theme as never,
		{
			state: {},
		} as never,
	);
	const preview = folded.render(120).join("\n");
	assert.match(preview, /via browser \(headed Chrome\)/);
	assert.match(preview, /line 11/);
	assert.doesNotMatch(preview, /line 19/);
	assert.match(preview, /8 more lines/);
	const expanded = tool.renderResult!(
		result,
		{ expanded: true, isPartial: false },
		theme as never,
		{
			lastComponent: folded,
			state: {},
		} as never,
	);
	assert.equal(expanded, folded);
	assert.match(expanded.render(120).join("\n"), /line 19/);
	assert.deepEqual(result.content, [{ type: "text", text: body }]);
	const search = tool.renderResult!(
		{ ...result, details: undefined },
		{ expanded: true, isPartial: false },
		theme as never,
		{ state: {} } as never,
	);
	assert.doesNotMatch(search.render(120).join("\n"), /via browser/);
});
