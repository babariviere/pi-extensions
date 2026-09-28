import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prewalk } from "./prewalk.ts";

test("prewalk ranks path matches, includes bounded excerpts, and ignores hidden, generated and linked files", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "prewalk-"));
	try {
		await mkdir(path.join(cwd, "src"));
		await mkdir(path.join(cwd, "node_modules"));
		await mkdir(path.join(cwd, ".private"));
		await writeFile(path.join(cwd, "src", "session-advisory.ts"), "export const sessionAdvisory = 42;\n");
		await writeFile(path.join(cwd, "src", "other.ts"), "// session advisory\n");
		await writeFile(path.join(cwd, "node_modules", "session.ts"), "session advisory\n");
		await writeFile(path.join(cwd, ".private", "session.ts"), "session advisory\n");
		await symlink(path.join(cwd, "src", "session-advisory.ts"), path.join(cwd, "session-link.ts"));
		const result = await prewalk(cwd, "Where is session advisory implemented?");
		assert.match(result.map.split("\n")[0] ?? "", /src\/session-advisory.ts/);
		assert.match(result.map, /sessionAdvisory/);
		assert.doesNotMatch(result.map, /node_modules|\.private|session-link/);
		assert.equal(result.filesSeen, 2);
		assert.equal(result.truncated, false);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("prewalk does not scan without distinctive words and keeps excerpts short", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "prewalk-"));
	try {
		await writeFile(path.join(cwd, "feature.ts"), `feature ${"x".repeat(400)}\n`);
		assert.equal((await prewalk(cwd, "please fix the code")).filesSeen, 0);
		const result = await prewalk(cwd, "feature");
		assert.ok(result.map.length < 300);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("prewalk reports no matches without inventing paths", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "prewalk-"));
	try {
		await writeFile(path.join(cwd, "other.ts"), "export const value = 1;\n");
		const result = await prewalk(cwd, "authentication");
		assert.match(result.map, /No likely files/);
		assert.equal(result.filesSeen, 1);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("prewalk caps total bytes read and reports incomplete search", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "prewalk-"));
	try {
		const body = "x".repeat(16 * 1024);
		for (let i = 0; i < 385; i++) {
			await writeFile(path.join(cwd, `file-${String(i).padStart(3, "0")}.ts`), body);
		}
		const result = await prewalk(cwd, "authentication");
		assert.equal(result.filesSeen, 384);
		assert.equal(result.truncated, true);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
