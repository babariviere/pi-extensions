import assert from "node:assert/strict";
import { test } from "node:test";
import { paneLabel, parseHerdrJson, parsePaneId, parseTab, parseTabs } from "./herdr.ts";

test("parseHerdrJson reads the JSON line and extracts result", () => {
	const out = parseHerdrJson('{"id":"cli:tab:list","result":{"tabs":[]}}');
	assert.equal(out?.ok, true);
	assert.deepEqual(out?.result, { tabs: [] });
});

test("parseHerdrJson tolerates leading log lines", () => {
	const out = parseHerdrJson('some log\nanother line\n{"id":"x","result":{"pane_id":"wA:p3"}}');
	assert.equal(out?.ok, true);
	assert.deepEqual(out?.result, { pane_id: "wA:p3" });
});

test("parseHerdrJson surfaces errors and returns undefined for non-json", () => {
	const err = parseHerdrJson('{"id":"x","error":{"message":"boom"}}');
	assert.equal(err?.ok, false);
	assert.equal(err?.error, "boom");
	assert.equal(parseHerdrJson("no json here"), undefined);
	assert.equal(parseHerdrJson(""), undefined);
});

test("parseTabs is tolerant of field-name variation", () => {
	const tabs = parseTabs({
		tabs: [
			{ tab_id: "wA:t1", label: "subagents", workspace_id: "wA" },
			{ tabId: "wA:t2", label: "other" },
			{ nope: true },
		],
	});
	assert.equal(tabs.length, 2);
	assert.equal(tabs[0].tabId, "wA:t1");
	assert.equal(tabs[0].label, "subagents");
	assert.equal(tabs[0].workspaceId, "wA");
	assert.equal(tabs[1].tabId, "wA:t2");
});

test("parseTab reads direct and nested tab objects", () => {
	assert.equal(parseTab({ tab_id: "wA:t5", label: "x" })?.tabId, "wA:t5");
	assert.equal(parseTab({ tab: { tab_id: "wA:t6" } })?.tabId, "wA:t6");
	assert.equal(parseTab({}), undefined);
});

test("parseTab captures the root pane id from a tab create response", () => {
	const tab = parseTab({ tab: { tab_id: "wA:t7", label: "subagents" }, root_pane: { pane_id: "wA:pC" } });
	assert.equal(tab?.tabId, "wA:t7");
	assert.equal(tab?.rootPaneId, "wA:pC");
	assert.equal(parseTab({ tab_id: "wA:t8" })?.rootPaneId, undefined);
});

test("paneLabel combines the agent name with a clamped single-line task slug", () => {
	assert.equal(paneLabel("worker", ""), "worker");
	assert.equal(paneLabel("worker", "   "), "worker");
	assert.equal(paneLabel("worker", "fix the bug"), "worker \u00b7 fix the bug");
	assert.equal(paneLabel("worker", "line one\nline two\ttabbed"), "worker \u00b7 line one line two tabbed");
	const long = paneLabel("reviewer", "a".repeat(80), 10);
	assert.equal(long, `reviewer \u00b7 ${"a".repeat(10)}\u2026`);
});

test("parsePaneId reads direct and nested pane ids", () => {
	assert.equal(parsePaneId({ pane_id: "wA:p1" }), "wA:p1");
	assert.equal(parsePaneId({ pane: { pane_id: "wA:p2" } }), "wA:p2");
	assert.equal(parsePaneId({ agent: { paneId: "wA:p3" } }), "wA:p3");
	assert.equal(parsePaneId({}), undefined);
});
