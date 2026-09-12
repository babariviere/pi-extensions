import assert from "node:assert/strict";
import { test } from "node:test";

import { applyCodeModeStateNotes, payloadInspectorLines, readCodeModeStateNotes } from "./inspect-preview.ts";

/** A theme that marks bold with «» and passes colors through, so lines read plainly. */
const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => `«${text}»`,
} as never;

test("collapsed payloads cost one line naming every key and size", () => {
	const lines = payloadInspectorLines({
		payloads: { body: "a\nb\nc", task: "x".repeat(2048) },
		expanded: false,
		theme,
	});
	assert.equal(lines.length, 1);
	assert.match(lines[0]!, /^π body \(5 B\) · task \(2\.0 KB\)/);
});

test("expanded payloads show a bold key header and bounded content", () => {
	const lines = payloadInspectorLines({
		payloads: { body: ["one", "two"].join("\n") },
		expanded: true,
		theme,
	});
	assert.deepEqual(lines, ["π body (7 B)", "«π.body» · 7 B · 2 lines", "one", "two"]);
});

test("consecutive payloads are separated by a blank line", () => {
	const lines = payloadInspectorLines({
		payloads: { a: "first", b: "second" },
		expanded: true,
		theme,
	});
	assert.deepEqual(lines, [
		"π a (5 B) · b (6 B)",
		"«π.a» · 5 B · 1 line",
		"first",
		"",
		"«π.b» · 6 B · 1 line",
		"second",
	]);
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

test("τ notes are read off a partial update and ignored otherwise", () => {
	assert.deepEqual(readCodeModeStateNotes({ stateNotes: [{ ref: "code-mode.state.set", key: "a" }] }), [
		{ ref: "code-mode.state.set", key: "a" },
	]);
	assert.deepEqual(readCodeModeStateNotes({ stateNotes: ["nope", { key: "no ref" }] }), []);
	assert.deepEqual(readCodeModeStateNotes({}), []);
	assert.deepEqual(readCodeModeStateNotes(undefined), []);
});

test("τ notes fill in each operation's body, in order", () => {
	const audits = [
		{ ref: "code-mode.state.set" },
		{ ref: "pi.read", result: "file" },
		{ ref: "code-mode.state.get" },
		{ ref: "code-mode.state.delete" },
	];
	const applied = applyCodeModeStateNotes(audits, [
		{ ref: "code-mode.state.set", key: "a", preview: '{"n":1}' },
		{ ref: "code-mode.state.get", key: "a", preview: '{"n":1}' },
		{ ref: "code-mode.state.delete", key: "a", detail: "deleted" },
	]);
	assert.deepEqual(
		applied.map((audit) => audit.result),
		['{"n":1}', "file", '{"n":1}', "deleted"],
	);
});

test("a reloaded transcript has no notes and keeps its rows unchanged", () => {
	const audits = [{ ref: "code-mode.state.set" }];
	assert.equal(applyCodeModeStateNotes(audits, undefined), audits);
	assert.equal(applyCodeModeStateNotes(audits, []), audits);
});
