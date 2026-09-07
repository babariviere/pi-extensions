import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { applyPatch, parseApplyPatch } from "./apply-patch.ts";

const workspace = (): string => mkdtempSync(join(tmpdir(), "spindle-patch-"));

test("parses V4A file operations, anchors, moves, and End of File", () => {
	const actions = parseApplyPatch(`*** Begin Patch
*** Add File: added.txt
+one
+two
*** Update File: before.txt
*** Move to: after.txt
@@ section
-old
+new
 tail
*** End of File
*** Delete File: deleted.txt
*** End Patch`);
	assert.deepEqual(actions, [
		{ kind: "add", path: "added.txt", content: "one\ntwo", line: 2 },
		{
			kind: "update",
			path: "before.txt",
			moveTo: "after.txt",
			line: 5,
			hunks: [
				{
					anchors: ["section"],
					oldLines: ["old", "tail"],
					newLines: ["new", "tail"],
					endOfFile: true,
					line: 7,
				},
			],
		},
		{ kind: "delete", path: "deleted.txt", line: 12 },
	]);
});

test("applies stacked V4A anchors", async () => {
	const cwd = workspace();
	writeFileSync(join(cwd, "nested.txt"), "class Outer\n  method one\n    unchanged\n  method two\n    old\n");
	await applyPatch(
		cwd,
		"*** Begin Patch\n*** Update File: nested.txt\n@@ class Outer\n@@   method two\n-    old\n+    new\n*** End Patch",
	);
	assert.equal(
		readFileSync(join(cwd, "nested.txt"), "utf8"),
		"class Outer\n  method one\n    unchanged\n  method two\n    new\n",
	);
});

test("applies a complete multi-file patch and preserves CRLF updates", async () => {
	const cwd = workspace();
	writeFileSync(join(cwd, "before.txt"), "header\r\nsection\r\nold\r\ntail\r\n");
	writeFileSync(join(cwd, "deleted.txt"), "remove me\n");
	const guarded: string[] = [];

	const changes = await applyPatch(
		cwd,
		`*** Begin Patch
*** Add File: nested/added.txt
+one
+two
*** Update File: before.txt
*** Move to: nested/after.txt
@@ section
-old
+new
 tail
*** End of File
*** Delete File: deleted.txt
*** End Patch`,
		(path) => guarded.push(path),
	);

	assert.deepEqual(changes, [
		{ kind: "add", path: "nested/added.txt" },
		{ kind: "move", path: "before.txt", moveTo: "nested/after.txt" },
		{ kind: "delete", path: "deleted.txt" },
	]);
	assert.equal(readFileSync(join(cwd, "nested/added.txt"), "utf8"), "one\ntwo");
	assert.equal(readFileSync(join(cwd, "nested/after.txt"), "utf8"), "header\r\nsection\r\nnew\r\ntail\r\n");
	assert.equal(existsSync(join(cwd, "before.txt")), false);
	assert.equal(existsSync(join(cwd, "deleted.txt")), false);
	assert.deepEqual(guarded, [
		resolve(cwd, "nested/added.txt"),
		resolve(cwd, "before.txt"),
		resolve(cwd, "nested/after.txt"),
		resolve(cwd, "deleted.txt"),
	]);
});

test("a move without hunks preserves file bytes", async () => {
	const cwd = workspace();
	const bytes = Buffer.from([0, 255, 13, 10]);
	writeFileSync(join(cwd, "before.bin"), bytes);
	await applyPatch(cwd, "*** Begin Patch\n*** Update File: before.bin\n*** Move to: after.bin\n*** End Patch");
	assert.deepEqual(readFileSync(join(cwd, "after.bin")), bytes);
	assert.equal(existsSync(join(cwd, "before.bin")), false);
});

test("validates every hunk before creating an earlier file", async () => {
	const cwd = workspace();
	writeFileSync(join(cwd, "target.txt"), "actual\n");
	await assert.rejects(
		() =>
			applyPatch(
				cwd,
				`*** Begin Patch
*** Add File: should-not-exist.txt
+content
*** Update File: target.txt
@@
-missing
+replacement
*** End Patch`,
			),
		/context not found.*missing/,
	);
	assert.equal(existsSync(join(cwd, "should-not-exist.txt")), false);
	assert.equal(readFileSync(join(cwd, "target.txt"), "utf8"), "actual\n");
});

test("parse failures never modify files and include a patch line", async () => {
	const cwd = workspace();
	writeFileSync(join(cwd, "target.txt"), "original\n");
	await assert.rejects(
		() =>
			applyPatch(
				cwd,
				`*** Begin Patch
*** Update File: target.txt
@@
-original
replacement
*** End Patch`,
			),
		/Invalid patch at line 5: hunk lines must start/,
	);
	assert.equal(readFileSync(join(cwd, "target.txt"), "utf8"), "original\n");
});

test("rejects absolute, traversal, duplicate, and symlink-escaping paths before writes", async () => {
	const cwd = workspace();
	const outside = workspace();
	writeFileSync(join(outside, "secret.txt"), "secret\n");
	symlinkSync(outside, join(cwd, "link"));

	for (const [path, message] of [
		["/tmp/absolute.txt", /must be relative/],
		["../outside.txt", /escapes the workspace/],
		["link/secret.txt", /escapes the workspace through a symlink/],
	] as const) {
		await assert.rejects(() => applyPatch(cwd, `*** Begin Patch\n*** Add File: ${path}\n+x\n*** End Patch`), message);
	}

	await assert.rejects(
		() =>
			applyPatch(cwd, "*** Begin Patch\n*** Add File: same.txt\n+one\n*** Add File: same.txt\n+two\n*** End Patch"),
		/used by multiple operations/,
	);
	assert.equal(existsSync(join(cwd, "same.txt")), false);

	mkdirSync(join(cwd, "real"));
	symlinkSync(join(cwd, "real"), join(cwd, "alias"));
	await assert.rejects(
		() =>
			applyPatch(
				cwd,
				"*** Begin Patch\n*** Add File: real/aliased.txt\n+one\n*** Add File: alias/aliased.txt\n+two\n*** End Patch",
			),
		/used by multiple operations/,
	);
	assert.equal(existsSync(join(cwd, "real/aliased.txt")), false);
});
