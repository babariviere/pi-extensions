import assert from "node:assert/strict";
import { test } from "node:test";
import { BrowserManager, BROWSER_ACTIONS, normalizeUrl, SAME_TAB_SCRIPT } from "./manager.ts";
import { DEFAULT_SETTINGS } from "./settings.ts";
import { createBrowserTool, missingArguments, toToolResult } from "./tool.ts";

test("the tool schema offers exactly the manager's actions", () => {
	const tool = createBrowserTool(() => new BrowserManager(DEFAULT_SETTINGS), DEFAULT_SETTINGS);
	const action = (tool.parameters as { properties: { action: { anyOf: { const: string }[] } } }).properties.action;
	assert.deepEqual(
		action.anyOf.map((a) => a.const),
		[...BROWSER_ACTIONS],
	);
});

test("SAME_TAB_SCRIPT is plain JavaScript", () => {
	assert.doesNotThrow(() => new Function(SAME_TAB_SCRIPT));
});

test("missingArguments checks per-action requirements", () => {
	assert.equal(missingArguments({ action: "open" }), "browser open requires url");
	assert.equal(missingArguments({ action: "type", ref: 2 }), "browser type requires text");
	assert.equal(missingArguments({ action: "type", ref: 2, text: "" }), undefined);
	assert.equal(missingArguments({ action: "snapshot" }), undefined);
	assert.equal(missingArguments({ action: "list" }), undefined);
});

test("normalizeUrl adds https to bare hosts and rejects other schemes", () => {
	assert.equal(normalizeUrl("example.com/a"), "https://example.com/a");
	assert.equal(normalizeUrl("http://localhost:3000"), "http://localhost:3000/");
	assert.equal(normalizeUrl("about:blank"), "about:blank");
	assert.throws(() => normalizeUrl("javascript:alert(1)"), /Unsupported URL scheme/);
	assert.throws(() => normalizeUrl("http://"), /Invalid URL/);
});

test("toToolResult renders snapshots, screenshots, and eval values", () => {
	const snap = toToolResult("click", {
		pageId: "p1",
		url: "https://x.dev",
		title: "X",
		newPages: ["p2"],
		snapshot: {
			url: "https://x.dev",
			title: "X",
			text: "hi",
			textTruncated: false,
			totalTextChars: 2,
			elements: [],
			totalElements: 0,
		},
	});
	const text = (snap.content[0] as { text: string }).text;
	assert.match(text, /^Page p1\nOpened new page\(s\): p2\n\nTitle: X/);
	assert.equal(snap.structuredContent.pageId, "p1");

	const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
	const shot = toToolResult("screenshot", { pageId: "p1", url: "u", title: "t", image });
	assert.deepEqual(shot.content[1], image);

	const evaluated = toToolResult("eval", { pageId: "p1", url: "u", title: "t", value: { n: 1 } });
	assert.match((evaluated.content[0] as { text: string }).text, /Result:\n\{\n  "n": 1\n\}/);
});
