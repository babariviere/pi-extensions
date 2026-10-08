import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveSpawnDirectory } from "./spawn-directory.ts";
import type { SessionRef } from "./session-ref.ts";

async function fixture(run: (parent: SessionRef, other: string, agentDir: string) => Promise<void>) {
	const root = await mkdtemp(join(tmpdir(), "spawn-directory-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	const agentDir = join(root, "agent");
	const parent = { cwd: join(root, "parent"), projectTrusted: true };
	const other = join(root, "other");
	await Promise.all([agentDir, parent.cwd, other].map((path) => mkdir(path)));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		await run(parent, other, agentDir);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await rm(root, { recursive: true, force: true });
	}
}

test("spawn directory defaults to the parent and canonicalizes absolute, relative, home and symlink paths", async () => {
	await fixture(async (parent, other) => {
		assert.deepEqual(await resolveSpawnDirectory(undefined, parent), parent);
		assert.deepEqual(await resolveSpawnDirectory(".", parent), {
			cwd: await realpath(parent.cwd),
			projectTrusted: true,
		});
		const expected = { cwd: await realpath(other), projectTrusted: false };
		assert.deepEqual(await resolveSpawnDirectory("../other", parent), expected);
		assert.deepEqual(await resolveSpawnDirectory(other, parent), expected);
		await symlink(other, join(parent.cwd, "link"), "dir");
		assert.deepEqual(await resolveSpawnDirectory("link", parent), expected);
		assert.equal(
			(await resolveSpawnDirectory("~", { ...parent, projectTrusted: false })).cwd,
			await realpath(homedir()),
		);
	});
});

test("invalid cwd values, missing paths and files fail explicitly", async () => {
	await fixture(async (parent) => {
		for (const cwd of ["", " ", "\0", null, 1])
			await assert.rejects(resolveSpawnDirectory(cwd as string, parent), /non-empty directory path/);
		await assert.rejects(resolveSpawnDirectory("missing", parent), /existing directory/);
		await writeFile(join(parent.cwd, "file"), "not a directory");
		await assert.rejects(resolveSpawnDirectory("file", parent), /existing directory/);
	});
});

test("another project uses saved canonical trust without inheriting session-only parent approval", async () => {
	await fixture(async (parent, other, agentDir) => {
		const target = await realpath(other);
		await writeFile(join(agentDir, "trust.json"), JSON.stringify({ [target]: true }));
		assert.equal((await resolveSpawnDirectory(other, parent)).projectTrusted, true);
		assert.equal((await resolveSpawnDirectory(other, { ...parent, projectTrusted: false })).projectTrusted, false);
		await writeFile(join(agentDir, "trust.json"), JSON.stringify({ [target]: false }));
		await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
		assert.equal((await resolveSpawnDirectory(other, parent)).projectTrusted, false);
		await writeFile(join(agentDir, "trust.json"), "{}");
		assert.equal((await resolveSpawnDirectory(other, parent)).projectTrusted, true);
	});
});

test("saved parent-folder trust applies to a target but a closer denial wins", async () => {
	await fixture(async (parent, other, agentDir) => {
		const child = join(other, "child");
		await mkdir(child);
		await writeFile(join(agentDir, "trust.json"), JSON.stringify({ [await realpath(other)]: true }));
		assert.equal((await resolveSpawnDirectory(child, parent)).projectTrusted, true);
		await writeFile(
			join(agentDir, "trust.json"),
			JSON.stringify({
				[await realpath(other)]: true,
				[await realpath(child)]: false,
			}),
		);
		assert.equal((await resolveSpawnDirectory(child, parent)).projectTrusted, false);
	});
});
