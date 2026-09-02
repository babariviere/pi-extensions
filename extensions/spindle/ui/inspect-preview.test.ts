import assert from "node:assert/strict";
import { test } from "node:test";

import { payloadInspectorLines, stateInspectorLines } from "./inspect-preview.ts";

/** A theme that returns its text unchanged, so assertions read as plain lines. */
const theme = { fg: (_name: string, text: string) => text } as never;

test("collapsed payloads cost one line naming every key and size", () => {
	const lines = payloadInspectorLines({
		payloads: { body: "a\nb\nc", task: "x".repeat(2048) },
		expanded: false,
		theme,
	});
	assert.equal(lines.length, 1);
	assert.match(lines[0]!, /^π body \(5 B\) · task \(2\.0 KB\)/);
});

test("expanded payloads show bounded content per key", () => {
	const lines = payloadInspectorLines({
		payloads: { body: ["one", "two", "three"].join("\n") },
		expanded: true,
		theme,
	});
	assert.deepEqual(lines, ["π body (13 B)", "π.body · 13 B · 3 lines", "one", "two", "three"]);
});

test("a long payload is elided with a count, not truncated silently", () => {
	const lines = payloadInspectorLines({
		payloads: { body: Array.from({ length: 50 }, (_value, index) => `line ${index}`).join("\n") },
		expanded: true,
		theme,
	});
	assert.equal(lines.at(-1), "  … 10 more lines");
});

test("payloads the write preview already renders are skipped", () => {
	const lines = payloadInspectorLines({
		payloads: { body: "written", note: "kept" },
		skipKeys: new Set(["body"]),
		expanded: true,
		theme,
	});
	assert.ok(lines.every((line) => !line.includes("π.body")));
	assert.ok(lines.some((line) => line.includes("π.note")));
});

test("no payloads renders nothing at all", () => {
	assert.deepEqual(payloadInspectorLines({ payloads: undefined, expanded: true, theme }), []);
	assert.deepEqual(payloadInspectorLines({ payloads: {}, expanded: true, theme }), []);
	assert.deepEqual(
		payloadInspectorLines({ payloads: { a: "x" }, skipKeys: new Set(["a"]), expanded: true, theme }),
		[],
	);
});

test("τ keys summarize collapsed and preview expanded", () => {
	const entries = [
		{ key: "index", bytes: 20002, preview: '{"files":["a.ts"]}' },
		{ key: "probe", bytes: 63 },
	];
	assert.deepEqual(stateInspectorLines({ entries, expanded: false, theme }).length, 1);
	assert.deepEqual(stateInspectorLines({ entries, expanded: true, theme }), [
		"τ index (19.5 KB) · probe (63 B)",
		"τ.index · 19.5 KB",
		'{"files":["a.ts"]}',
		"τ.probe · 63 B",
	]);
});

test("an empty scratchpad renders nothing", () => {
	assert.deepEqual(stateInspectorLines({ entries: [], expanded: true, theme }), []);
	assert.deepEqual(stateInspectorLines({ entries: undefined, expanded: true, theme }), []);
});
