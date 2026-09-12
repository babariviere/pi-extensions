// Copyright 2025 OpenAI. Licensed under Apache-2.0 (see apply-patch.LICENSE).
// Compatibility tests for Codex apply-patch parser at 9e868bd9dc007c05e84a98e0b1f4e31dc98c5e6a. See apply-patch.NOTICE.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseApplyPatch, trimWhitespace } from "./apply-patch-parser.ts";
const wrap = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`;
const parse = (body: string) => parseApplyPatch(wrap(body));
test("accepts envelope and records fields", () => {
	const [add, update, del] = parse(
		"*** Environment ID: remote\n*** Add File: new.txt\n+one\n+two\n*** Update File: old.txt\n*** Move to: moved.txt\n@@ section\n context\n-old\n+new\n*** End of File\n*** Delete File: gone.txt",
	);
	assert.deepEqual(add, { kind: "add", path: "new.txt", content: "one\ntwo\n", line: 3 });
	assert.deepEqual(update, {
		kind: "update",
		path: "old.txt",
		moveTo: "moved.txt",
		line: 6,
		hunks: [
			{
				anchors: ["section"],
				oldLines: ["context", "old"],
				newLines: ["context", "new"],
				contextLineIndices: [[0, 0]],
				endOfFile: true,
				line: 8,
			},
		],
	});
	assert.deepEqual(del, { kind: "delete", path: "gone.txt", line: 13 });
});
test("accepts padding and heredoc wrappers", () => {
	for (const input of [
		"  *** Begin Patch \n*** Add File: x\n+a\n *** End Patch \n",
		"<<EOF\n*** Begin Patch\n*** Add File: x\n+a\n*** End Patch\nEOF\n",
		"<<'EOF'\n*** Begin Patch\n*** Add File: x\n+a\n*** End Patch\nEOF",
		'<<"EOF"\n*** Begin Patch\n*** Add File: x\n+a\n*** End Patch\nEOF',
		wrap("*** Update File: x\n@@\n-old\n+new\n*** End of File\n\n"),
	])
		assert.doesNotThrow(() => parseApplyPatch(input));
});
test("preserves empty context and context index pairs", () => {
	const [action] = parse("*** Update File: x\n@@ anchor\n one\n\n-two\n+three");
	assert.equal(action?.kind, "update");
	if (action?.kind === "update")
		assert.deepEqual(action.hunks[0], {
			anchors: ["anchor"],
			oldLines: ["one", "", "two"],
			newLines: ["one", "", "three"],
			contextLineIndices: [
				[0, 0],
				[1, 1],
			],
			endOfFile: false,
			line: 3,
		});
});
test("rejects structural violations with Codex errors", () => {
	const cases: Array<[string, RegExp]> = [
		["", /first line/],
		["*** Begin Patch", /last line/],
		[wrap("*** Update File: x"), /hunk for path 'x' is empty/],
		[wrap("*** Update File: x\n@@\n*** End Patch"), /does not contain any lines/],
		[wrap("*** Update File: x\n*** Move to: y\n*** Move to: z\n@@\n-old\n+new"), /Unexpected line found/],
		[wrap("*** Environment ID: one\n*** Environment ID: two"), /cannot be specified more than once/],
		[wrap("*** Environment ID:   \n*** Add File: x\n+a"), /environment_id cannot be empty/],
		[wrap("*** Update File: x\n@@\n-old\n+new\n*** End of File\nnot a header"), /Expected update hunk/],
	];
	for (const [input, error] of cases) assert.throws(() => parseApplyPatch(input), error);
});
test("rejects stacked anchors and hunkless moves", () => {
	assert.throws(() => parse("*** Update File: x\n*** Move to: y"), /empty/);
	assert.throws(() => parse("*** Update File: x\n@@ first\n@@ second\n-old\n+new"), /Unexpected line found/);
});
test("handles EOF followed by another chunk", () => {
	const [action] = parse("*** Update File: x\n@@\n-old\n+new\n*** End of File\n\n@@ tail\n-last\n+final");
	assert.equal(action?.kind, "update");
	if (action?.kind === "update")
		assert.deepEqual(
			action.hunks.map(({ endOfFile, anchors }) => ({ endOfFile, anchors })),
			[
				{ endOfFile: true, anchors: [] },
				{ endOfFile: false, anchors: ["tail"] },
			],
		);
});
test("matches Rust White_Space, not BOM", () => {
	assert.equal(trimWhitespace("\u0085*** Begin Patch\u0085"), "*** Begin Patch");
	assert.equal(trimWhitespace("\uFEFF*** Begin Patch\uFEFF"), "\uFEFF*** Begin Patch\uFEFF");
	assert.throws(() => parseApplyPatch("\uFEFF*** Begin Patch\n*** End Patch"), /first line/);
});
test("reports original hunk line numbers", () => {
	assert.throws(() => parse("*** Add File: x\nnot added"), /invalid hunk at line 3/);
	assert.throws(() => parse("*** Update File: x"), /invalid hunk at line 2/);
});
test("empty patches parse, and empty Add File sections create empty content", () => {
	assert.deepEqual(parseApplyPatch("*** Begin Patch\n*** End Patch"), []);
	assert.deepEqual(parse("*** Add File: empty"), [{ kind: "add", path: "empty", content: "", line: 2 }]);
	assert.deepEqual(parse("*** Add File: blank\n+"), [{ kind: "add", path: "blank", content: "\n", line: 2 }]);
});

test("matches both upstream CR-stripping passes without stripping all CRs", () => {
	for (const ending of ["\n", "\r\n", "\r\r\n"]) {
		const patch = ["*** Begin Patch", "*** Add File: x", "+one", "*** End Patch"].join(ending);
		assert.deepEqual(parseApplyPatch(patch), [{ kind: "add", path: "x", content: "one\n", line: 2 }]);
	}
	assert.deepEqual(parseApplyPatch("*** Begin Patch\n*** Add File: x\n+one\r\r\r\n*** End Patch"), [
		{ kind: "add", path: "x", content: "one\r\n", line: 2 },
	]);
});

test("the first update chunk needs no marker, and indented markers remain context", () => {
	const [action] = parse("*** Update File: x\n *** Add File: literal\n-old\n+new\n@@ anchor \t\n-last\n+final");
	assert.equal(action?.kind, "update");
	if (action?.kind !== "update") return;
	assert.deepEqual(action.hunks[0]?.oldLines, ["*** Add File: literal", "old"]);
	assert.deepEqual(action.hunks[1]?.anchors, ["anchor"]);
});

test("rejects malformed boundaries and non-update blank lines", () => {
	for (const patch of [
		"*** Begin Patch\n*** Add File: x\n+a",
		wrap("*** Add File: x\n+a") + "\ntrailing",
		"<<END\n" + wrap("*** Add File: x\n+a") + "\nEND",
		wrap("\n*** Add File: x\n+a"),
		wrap("*** Add File: x\n"),
		wrap("*** Delete File: x\n-content"),
		wrap("*** Add File: x\n+a\n*** Environment ID: late"),
	])
		assert.throws(() => parseApplyPatch(patch), /invalid (patch|hunk)/);
});

test("accepts context-only hunks", () => {
	const [action] = parse("*** Update File: x\n@@\n context");
	assert.equal(action?.kind, "update");
	if (action?.kind === "update") assert.deepEqual(action.hunks[0]?.oldLines, ["context"]);
});
