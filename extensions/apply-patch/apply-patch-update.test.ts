// Copyright 2025 OpenAI. Licensed under Apache-2.0 (see apply-patch.LICENSE).
// Compatibility tests for Codex file_update, seek_sequence, and text_file at 9e868bd9dc007c05e84a98e0b1f4e31dc98c5e6a. See apply-patch.NOTICE.
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyPatchUpdate } from "./apply-patch-update.ts";
import type { ApplyPatchHunk } from "./apply-patch-parser.ts";
type Mode = "normalizeToLf" | "preserveLineEndings";
const h = (x: Partial<ApplyPatchHunk>): ApplyPatchHunk => ({
	anchors: [],
	oldLines: [],
	newLines: [],
	contextLineIndices: [],
	endOfFile: false,
	line: 1,
	...x,
});
const run = (content: string, hunks: ApplyPatchHunk[], mode: Mode) =>
	applyPatchUpdate(content, "fixture.txt", hunks, mode);
const cases = [
	{
		name: "replace trailing blank lines",
		content: "a\n\n",
		oldLines: ["a", "", ""],
		newLines: ["A", "", ""],
		expected: { normalizeToLf: "A\n", preserveLineEndings: "A\n\n" },
	},
	{
		name: "delete all",
		content: "a\nb\n",
		oldLines: ["a", "b"],
		newLines: [],
		expected: { normalizeToLf: "", preserveLineEndings: "" },
	},
	{
		name: "pure addition at EOF despite anchors",
		content: "a\nb\n",
		anchors: ["a"],
		oldLines: [],
		newLines: ["x"],
		expected: { normalizeToLf: "a\nb\nx\n", preserveLineEndings: "a\nb\nx\n" },
	},
	{
		name: "fuzzy curly quote normalization",
		content: "'hello'\n",
		oldLines: ["‘hello’"],
		newLines: ["done"],
		expected: { normalizeToLf: "done\n", preserveLineEndings: "done\n" },
	},
	{
		name: "fuzzy whitespace normalization",
		content: "heading\n",
		oldLines: ["  heading  "],
		newLines: ["done"],
		expected: { normalizeToLf: "done\n", preserveLineEndings: "done\n" },
	},
	{
		name: "trailing empty fallback",
		content: "one\ntwo\n",
		oldLines: ["two", ""],
		newLines: ["TWO", ""],
		endOfFile: true,
		expected: { normalizeToLf: "one\nTWO\n", preserveLineEndings: "one\nTWO\n" },
	},
] as const;
for (const mode of ["normalizeToLf", "preserveLineEndings"] as const)
	for (const item of cases)
		test(`update ${mode}: ${item.name}`, () =>
			assert.equal(
				run(
					item.content,
					[
						h({
							anchors: "anchors" in item ? [...item.anchors] : [],
							oldLines: [...item.oldLines],
							newLines: [...item.newLines],
							endOfFile: "endOfFile" in item ? item.endOfFile : false,
						}),
					],
					mode,
				),
				item.expected[mode],
			));
for (const mode of ["normalizeToLf", "preserveLineEndings"] as const) {
	test(`${mode}: exact matches outrank earlier whitespace-fuzzy matches`, () => {
		assert.equal(run("  old\nold\n", [h({ oldLines: ["old"], newLines: ["new"] })], mode), "  old\nnew\n");
		assert.equal(run("  old\nold  \n", [h({ oldLines: ["old"], newLines: ["new"] })], mode), "  old\nnew\n");
	});
	test(`${mode}: all Codex punctuation and space mappings are supported`, () => {
		for (const [chars, ascii] of [
			["\u2010\u2011\u2012\u2013\u2014\u2015\u2212", "-"],
			["\u2018\u2019\u201a\u201b", "'"],
			["\u201c\u201d\u201e\u201f", '"'],
			["\u00a0\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u202f\u205f\u3000", " "],
		]) {
			for (const char of chars!) {
				assert.equal(run(`a${char}b\n`, [h({ oldLines: [`a${ascii}b`], newLines: ["new"] })], mode), "new\n");
			}
		}
		assert.throws(
			() => run("café\n", [h({ oldLines: ["cafe\u0301"], newLines: ["new"] })], mode),
			/Failed to find expected lines/,
		);
	});
	test(`${mode}: additions do not move the original-file matching cursor`, () => {
		assert.equal(
			run("a\nb\n", [h({ newLines: ["tail"] }), h({ oldLines: ["a"], newLines: ["A"] })], mode),
			"A\nb\ntail\n",
		);
		assert.equal(
			run("base\n", [h({ newLines: ["first"] }), h({ newLines: ["second"] })], mode),
			"base\nfirst\nsecond\n",
		);
	});
	test(`${mode}: updates add a final newline even to context-only changes`, () => {
		assert.equal(run("old", [h({ oldLines: ["old"], newLines: ["new"] })], mode), "new\n");
		assert.equal(
			run("old", [h({ oldLines: ["old"], newLines: ["old"], contextLineIndices: [[0, 0]] })], mode),
			"old\n",
		);
	});
	test(`${mode}: anchors must exist and hunks start strictly after them`, () => {
		assert.throws(
			() => run("old\n", [h({ anchors: ["absent"], newLines: ["new"] })], mode),
			/Failed to find context 'absent'/,
		);
		assert.throws(
			() => run("old\n", [h({ anchors: ["old"], oldLines: ["old"], newLines: ["new"] })], mode),
			/Failed to find expected lines/,
		);
	});
}

test("legacy and preserved endings match Codex's distinct append semantics", () => {
	const addition = h({ newLines: ["new"] });
	assert.equal(run("a\n\n", [addition], "normalizeToLf"), "a\nnew\n");
	assert.equal(run("a\n\n", [addition], "preserveLineEndings"), "a\n\nnew\n");
	assert.equal(run("a\r\n\r\n", [addition], "preserveLineEndings"), "a\r\n\r\nnew\r\n");
	assert.equal(run("a\r\nb", [addition], "preserveLineEndings"), "a\r\nb\r\nnew\r\n");
	assert.equal(run("a\rb\r", [h({ oldLines: ["a"], newLines: ["A"] })], "preserveLineEndings"), "A\rb\r");
	assert.equal(run("a\r\nb\r\n", [h({ oldLines: ["a"], newLines: ["A"] })], "normalizeToLf"), "A\nb\r\n");
});

test("preserve mode retains mixed line-ending bytes", () => {
	const patch = h({
		oldLines: ["one", "two", "three", "four"],
		newLines: ["one", "two", "THREE", "four"],
		contextLineIndices: [
			[0, 0],
			[1, 1],
			[3, 3],
		],
	});
	assert.equal(run("one\r\ntwo\rthree\nfour\r\n", [patch], "preserveLineEndings"), "one\r\ntwo\rTHREE\r\nfour\r\n");
});
test("preserves repeated context occurrence and original ending", () => {
	const patch = h({ oldLines: ["same", "same"], newLines: ["same", "changed"], contextLineIndices: [[0, 0]] });
	assert.equal(run("same\r\nsame\n", [patch], "preserveLineEndings"), "same\r\nchanged\r\n");
});
test("stable ordering keeps same-position insertions", () => {
	assert.equal(
		run("base\n", [h({ newLines: ["first"] }), h({ newLines: ["second"] })], "normalizeToLf"),
		"base\nfirst\nsecond\n",
	);
});
test("EOF uses final occurrence and preservation rejects overlap", () => {
	const repeated = [
		h({ oldLines: ["one"], newLines: ["first"], endOfFile: true }),
		h({ oldLines: ["one"], newLines: ["second"], endOfFile: true }),
	];
	assert.equal(run("one\none\n", repeated, "normalizeToLf"), "one\nfirst\n");
	assert.throws(() => run("one\none\n", repeated, "preserveLineEndings"), /Failed to find expected lines/);
});
test("empty files and deletion retain newline behavior", () => {
	const addition = h({ newLines: ["new"] });
	assert.equal(run("", [addition], "normalizeToLf"), "new\n");
	assert.equal(run("", [addition], "preserveLineEndings"), "new\n");
	assert.equal(run("a\r\n", [h({ oldLines: ["a"], newLines: [] })], "preserveLineEndings"), "");
});
test("context-only replacement is a no-op and uses original lines", () => {
	assert.equal(
		run("a\r\nb\n", [h({ oldLines: ["a"], newLines: ["a"], contextLineIndices: [[0, 0]] })], "preserveLineEndings"),
		"a\r\nb\n",
	);
	const hunks = [h({ oldLines: ["a"], newLines: ["A"] }), h({ oldLines: ["b"], newLines: ["B"] })];
	assert.equal(run("a\nb\n", hunks, "normalizeToLf"), "A\nB\n");
});
test("fuzzy matching does not rewrite context in preservation mode", () => {
	const patch = h({ oldLines: ["heading  ", "body"], newLines: ["heading  ", "BODY"], contextLineIndices: [[0, 0]] });
	assert.equal(run("heading\r\nbody\n", [patch], "preserveLineEndings"), "heading\r\nBODY\r\n");
});
