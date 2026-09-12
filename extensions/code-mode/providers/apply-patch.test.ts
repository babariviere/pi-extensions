import assert from "node:assert/strict";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { assertWriteAllowed, type SandboxPolicy } from "../sandbox/policy.ts";
import { applyPatch, type ApplyPatchFileUpdateMode } from "./apply-patch.ts";

const workspace = (t: TestContext): string => {
	const path = mkdtempSync(join(tmpdir(), "code-mode-patch-"));
	t.after(() => rmSync(path, { recursive: true, force: true }));
	return path;
};
const wrap = (body: string): string => `*** Begin Patch\n${body}\n*** End Patch`;

test("returns existing change metadata for all operations and guards both sides of a move", async (t) => {
	const cwd = workspace(t);
	writeFileSync(join(cwd, "before.txt"), "header\r\nsection\r\nold\r\ntail\r\n");
	writeFileSync(join(cwd, "deleted.txt"), "remove me\n");
	const guarded: string[] = [];
	const changes = await applyPatch(
		cwd,
		wrap(
			"*** Add File: nested/added.txt\n+one\n+two\n*** Update File: before.txt\n*** Move to: nested/after.txt\n@@ section\n-old\n+new\n tail\n*** End of File\n*** Delete File: deleted.txt",
		),
		(path) => guarded.push(path),
		"preserveLineEndings",
	);
	assert.deepEqual(changes, [
		{ kind: "add", path: "nested/added.txt" },
		{ kind: "move", path: "before.txt", moveTo: "nested/after.txt" },
		{ kind: "delete", path: "deleted.txt" },
	]);
	assert.equal(readFileSync(join(cwd, "nested/added.txt"), "utf8"), "one\ntwo\n");
	assert.equal(readFileSync(join(cwd, "nested/after.txt"), "utf8"), "header\r\nsection\r\nnew\r\ntail\r\n");
	assert.equal(existsSync(join(cwd, "before.txt")), false);
	assert.equal(existsSync(join(cwd, "deleted.txt")), false);
	const paths = ["nested/added.txt", "before.txt", "nested/after.txt", "deleted.txt"].map((path) =>
		resolve(cwd, path),
	);
	assert.deepEqual(guarded, [...paths, ...paths]);
});

test("validates the entire syntax before any mutations", async (t) => {
	const cwd = workspace(t);
	await assert.rejects(
		() => applyPatch(cwd, wrap("*** Add File: earlier\n+one\n*** Update File: target\n@@\n-old\nreplacement")),
		/invalid hunk at line 7/,
	);
	assert.equal(existsSync(join(cwd, "earlier")), false);
});

test("later matching failures leave earlier operations applied, but not half an update", async (t) => {
	const cwd = workspace(t);
	writeFileSync(join(cwd, "target"), "old\n");
	await assert.rejects(
		() =>
			applyPatch(
				cwd,
				wrap("*** Add File: earlier\n+one\n*** Update File: target\n@@\n-old\n+new\n@@\n-missing\n+replacement"),
			),
		/Failed to find expected lines/,
	);
	assert.equal(readFileSync(join(cwd, "earlier"), "utf8"), "one\n");
	assert.equal(readFileSync(join(cwd, "target"), "utf8"), "old\n");
});

test("repeated paths are applied sequentially, including add, update, move, delete, and recreate", async (t) => {
	const cwd = workspace(t);
	const changes = await applyPatch(
		cwd,
		wrap(
			"*** Add File: a\n+one\n*** Add File: a\n+two\n*** Update File: ./a\n@@\n-two\n+three\n*** Update File: a\n*** Move to: b\n@@\n three\n*** Delete File: b\n*** Add File: b\n+four",
		),
	);
	assert.equal(changes.length, 6);
	assert.equal(existsSync(join(cwd, "a")), false);
	assert.equal(readFileSync(join(cwd, "b"), "utf8"), "four\n");
});

test("accepts absolute paths and parent-relative paths when permitted", async (t) => {
	const root = workspace(t);
	const cwd = join(root, "workspace");
	mkdirSync(cwd);
	const absolute = join(root, "absolute");
	await applyPatch(cwd, wrap(`*** Add File: ${absolute}\n+one\n*** Add File: ../relative\n+two`));
	assert.equal(readFileSync(absolute, "utf8"), "one\n");
	assert.equal(readFileSync(join(root, "relative"), "utf8"), "two\n");
});

test("paths may contain Unicode line separators, which are not patch line breaks", async (t) => {
	const cwd = workspace(t);
	for (const separator of ["\u2028", "\u2029"]) {
		const path = `first${separator}second`;
		await applyPatch(cwd, wrap(`*** Add File: ${path}\n+one\n*** Update File: ${path}\n@@\n-one\n+two`));
		assert.equal(readFileSync(join(cwd, path), "utf8"), "two\n");
	}
});

test("follows symlinks for adds and updates, and unlinks only the link on deletion", async (t) => {
	const cwd = workspace(t);
	const outside = workspace(t);
	writeFileSync(join(outside, "target"), "old\n");
	symlinkSync(join(outside, "target"), join(cwd, "link"));
	await applyPatch(
		cwd,
		wrap("*** Add File: link\n+one\n*** Update File: link\n@@\n-one\n+two\n*** Delete File: link"),
	);
	assert.equal(readFileSync(join(outside, "target"), "utf8"), "two\n");
	assert.equal(existsSync(join(cwd, "link")), false);
});

test("moves read the source symlink, write through the destination symlink, and unlink the source link", async (t) => {
	const cwd = workspace(t);
	writeFileSync(join(cwd, "source"), "old\n");
	writeFileSync(join(cwd, "destination"), "existing\n");
	symlinkSync(join(cwd, "source"), join(cwd, "source-link"));
	symlinkSync(join(cwd, "destination"), join(cwd, "destination-link"));
	await applyPatch(cwd, wrap("*** Update File: source-link\n*** Move to: destination-link\n@@\n-old\n+new"));
	assert.equal(readFileSync(join(cwd, "source"), "utf8"), "old\n");
	assert.equal(readFileSync(join(cwd, "destination"), "utf8"), "new\n");
	assert.equal(lstatSync(join(cwd, "destination-link")).isSymbolicLink(), true);
	assert.equal(existsSync(join(cwd, "source-link")), false);
});

test("a move to itself writes then unlinks, as Codex does", async (t) => {
	const cwd = workspace(t);
	writeFileSync(join(cwd, "a"), "old\n");
	await applyPatch(cwd, wrap("*** Update File: a\n*** Move to: ./a\n@@\n-old\n+new"));
	assert.equal(existsSync(join(cwd, "a")), false);
});

test("a failed move destination leaves its source intact", async (t) => {
	const cwd = workspace(t);
	writeFileSync(join(cwd, "source"), "old\n");
	mkdirSync(join(cwd, "directory"));
	await assert.rejects(() => applyPatch(cwd, wrap("*** Update File: source\n*** Move to: directory\n@@\n-old\n+new")));
	assert.equal(readFileSync(join(cwd, "source"), "utf8"), "old\n");
});

test("rejects invalid UTF-8 updates without replacing invalid bytes", async (t) => {
	const cwd = workspace(t);
	const bytes = Buffer.from([0xff, 10]);
	writeFileSync(join(cwd, "binary"), bytes);
	await assert.rejects(() => applyPatch(cwd, wrap("*** Update File: binary\n@@\n+new")), /encoded data was not valid/);
	assert.deepEqual(readFileSync(join(cwd, "binary")), bytes);
	// Deletes, unlike updates, need not decode the content.
	await applyPatch(cwd, wrap("*** Delete File: binary"));
	assert.equal(existsSync(join(cwd, "binary")), false);
});

test("retains UTF-8 BOMs when reading update targets", async (t) => {
	const cwd = workspace(t);
	writeFileSync(join(cwd, "bom"), "\ufeffone\ntwo\n");
	await applyPatch(cwd, wrap("*** Update File: bom\n@@\n-two\n+new"));
	assert.equal(readFileSync(join(cwd, "bom"), "utf8"), "\ufeffone\nnew\n");
});

test("sandbox guards still reject absolute, traversal, symlink escapes and move destinations before writes", async (t) => {
	const cwd = workspace(t);
	const outside = workspace(t);
	writeFileSync(join(cwd, "source"), "old\n");
	symlinkSync(outside, join(cwd, "link"));
	const policy: SandboxPolicy = { mode: "workspace-write", allowWrite: [cwd], denyRead: [], denyWrite: [] };
	const guard = (path: string) => assertWriteAllowed(policy, path);
	for (const body of [
		`*** Add File: ${join(outside, "absolute")}\n+no`,
		"*** Add File: ../escape\n+no",
		"*** Add File: link/escape\n+no",
		`*** Update File: source\n*** Move to: ${join(outside, "moved")}\n@@\n-old\n+new`,
	]) {
		await assert.rejects(
			() => applyPatch(cwd, wrap(`*** Add File: earlier\n+one\n${body}`), guard),
			/sandbox: write .* denied/,
		);
		assert.equal(existsSync(join(cwd, "earlier")), false);
	}
	assert.equal(readFileSync(join(cwd, "source"), "utf8"), "old\n");
});

test("rechecks guards between operations", async (t) => {
	const cwd = workspace(t);
	let checks = 0;
	const guard = () => {
		if (++checks === 4) throw new Error("policy changed");
	};
	await assert.rejects(
		() => applyPatch(cwd, wrap("*** Add File: one\n+one\n*** Add File: two\n+two"), guard),
		/policy changed/,
	);
	assert.equal(readFileSync(join(cwd, "one"), "utf8"), "one\n");
	assert.equal(existsSync(join(cwd, "two")), false);
});

test("large hunks do not exceed JavaScript's argument limit", async (t) => {
	const cwd = workspace(t);
	const count = 150_000;
	writeFileSync(join(cwd, "large"), "old\n");
	await applyPatch(cwd, wrap(`*** Update File: large\n@@\n-old\n${Array(count).fill("+new").join("\n")}`));
	assert.equal(readFileSync(join(cwd, "large"), "utf8"), "new\n".repeat(count));
});

test("uses Codex's environment switch only for the exact value 1", async (t) => {
	const cwd = workspace(t);
	const key = "CODEX_APPLY_PATCH_PRESERVE_LINE_ENDINGS";
	const previous = process.env[key];
	t.after(() => {
		if (previous === undefined) delete process.env[key];
		else process.env[key] = previous;
	});
	for (const [value, mode] of [
		[undefined, "normalizeToLf"],
		["0", "normalizeToLf"],
		["true", "normalizeToLf"],
		["1", "preserveLineEndings"],
	] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
		writeFileSync(join(cwd, "target"), "old\r\n");
		await applyPatch(cwd, wrap("*** Update File: target\n@@\n-old\n+new"));
		const expected: Record<ApplyPatchFileUpdateMode, string> = {
			normalizeToLf: "new\n",
			preserveLineEndings: "new\r\n",
		};
		assert.equal(readFileSync(join(cwd, "target"), "utf8"), expected[mode]);
	}
});
