import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
	type CloneCommand,
	cloneCommand,
	createRunSandbox,
	detectSharedStateWarnings,
	type PrepareCommand,
	prepareCommands,
	prepareWorkingCopy,
	sandboxPathFor,
	strategyOrder,
} from "./sandbox-clone.ts";

test("prepareCommands trusts mise and direnv config in the copy", () => {
	const commands = prepareCommands({
		path: "/sandboxes/repo/run",
		hasMiseConfig: true,
		hasEnvrc: true,
		available: { mise: true, direnv: true },
	});
	assert.deepEqual(commands, [
		{
			label: "mise trust",
			command: "mise",
			args: ["trust", "--all", "--yes", "--quiet", "-C", "/sandboxes/repo/run"],
		},
		{ label: "direnv allow", command: "direnv", args: ["allow", "/sandboxes/repo/run"] },
	]);
});

test("prepareCommands skips steps with no config or no tool", () => {
	assert.deepEqual(
		prepareCommands({
			path: "/x",
			hasMiseConfig: false,
			hasEnvrc: false,
			available: { mise: true, direnv: true },
		}),
		[],
	);
	assert.deepEqual(
		prepareCommands({
			path: "/x",
			hasMiseConfig: true,
			hasEnvrc: true,
			available: { mise: false, direnv: false },
		}),
		[],
	);
});

test("prepareWorkingCopy trusts a copy that has a mise config", async () => {
	const dir = mkdtempSync(join(tmpdir(), "night-trust-"));
	try {
		writeFileSync(join(dir, "mise.local.toml"), "[env]\nFOO = 'bar'\n");
		const calls: PrepareCommand[] = [];
		const result = await prepareWorkingCopy(dir, {
			run: (command) => {
				calls.push(command);
			},
			lookup: () => true,
		});
		assert.deepEqual(result.ran, ["mise trust"]);
		assert.deepEqual(result.problems, []);
		assert.deepEqual(calls[0].args.slice(0, 2), ["trust", "--all"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("prepareWorkingCopy reports a failed trust step instead of throwing", async () => {
	const dir = mkdtempSync(join(tmpdir(), "night-trust-"));
	try {
		writeFileSync(join(dir, "mise.toml"), "[tools]\n");
		const result = await prepareWorkingCopy(dir, {
			run: () => {
				throw new Error("mise: command failed\ndetail");
			},
			lookup: () => true,
		});
		assert.deepEqual(result.ran, []);
		assert.deepEqual(result.problems, ["mise trust: mise: command failed"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("trust: false skips the steps but still reports shared state", async () => {
	const dir = mkdtempSync(join(tmpdir(), "night-trust-"));
	try {
		writeFileSync(join(dir, "mise.toml"), "[tools]\n");
		writeFileSync(join(dir, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
		const result = await prepareWorkingCopy(dir, {
			trust: false,
			lookup: () => true,
		});
		assert.deepEqual(result.ran, []);
		assert.match(result.problems[0], /git linked worktree/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("detectSharedStateWarnings flags pointer files, not real directories", () => {
	const dir = mkdtempSync(join(tmpdir(), "night-shared-"));
	try {
		mkdirSync(join(dir, ".git"));
		mkdirSync(join(dir, ".jj", "repo"), { recursive: true });
		assert.deepEqual(detectSharedStateWarnings(dir), []);

		rmSync(join(dir, ".jj", "repo"), { recursive: true, force: true });
		writeFileSync(join(dir, ".jj", "repo"), "/elsewhere/.jj/repo\n");
		assert.match(detectSharedStateWarnings(dir)[0], /secondary jj workspace/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "night-sandbox-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

test("cloneCommand passes paths as arguments, never as shell text", () => {
	const command = cloneCommand("apfs", "/src/my repo", "/dest/run 1");
	assert.equal(command.command, "cp");
	assert.deepEqual(command.args, ["-c", "-R", "-p", "/src/my repo/.", "/dest/run 1"]);
});

test("cloneCommand uses reflink on Linux and plain copy as the floor", () => {
	assert.ok(cloneCommand("reflink", "/a", "/b").args.includes("--reflink=always"));
	assert.deepEqual(cloneCommand("copy", "/a", "/b").args, ["-R", "-p", "/a/.", "/b"]);
});

test("strategyOrder is platform specific and always ends in copy", () => {
	assert.deepEqual(strategyOrder("darwin"), ["apfs", "copy"]);
	assert.deepEqual(strategyOrder("linux"), ["reflink", "copy"]);
	assert.deepEqual(strategyOrder("win32"), ["copy"]);
});

test("sandboxPathFor groups by repo name", () => {
	assert.equal(
		sandboxPathFor("/root/sandboxes", "/Users/dev/src/phishing", "2026-08-29 2130"),
		"/root/sandboxes/phishing/2026-08-29 2130",
	);
});

test("createRunSandbox falls back to the next strategy and reports the failure", async () => {
	const source = join(dir, "repo");
	mkdirSync(source, { recursive: true });
	writeFileSync(join(source, "a.txt"), "hello");
	const attempted: string[] = [];
	const run = (command: CloneCommand): void => {
		attempted.push(command.args[0]);
		if (command.args[0] === "-c") throw new Error("cp: --clone not supported\nmore detail");
	};

	const result = await createRunSandbox({
		source,
		destination: join(dir, "sandbox"),
		platform: "darwin",
		run,
	});

	assert.equal(result.strategy, "copy");
	assert.deepEqual(attempted, ["-c", "-R"]);
	assert.deepEqual(result.fallbacks, ["apfs: cp: --clone not supported"]);
});

test("createRunSandbox rejects with every failure when nothing works", async () => {
	const source = join(dir, "repo");
	mkdirSync(source, { recursive: true });
	await assert.rejects(
		() =>
			createRunSandbox({
				source,
				destination: join(dir, "sandbox"),
				platform: "linux",
				run: () => {
					throw new Error("nope");
				},
			}),
		/could not clone .*\(reflink: nope; copy: nope\)/,
	);
});

test("createRunSandbox rejects a missing source", async () => {
	await assert.rejects(
		() =>
			createRunSandbox({
				source: join(dir, "absent"),
				destination: join(dir, "out"),
			}),
		/does not exist/,
	);
});

test("createRunSandbox really clones, and brings ignored files along", async () => {
	const source = join(dir, "repo");
	mkdirSync(join(source, "src"), { recursive: true });
	writeFileSync(join(source, "src", "a.txt"), "tracked");
	writeFileSync(join(source, "mise.local.toml"), "secret");

	const result = await createRunSandbox({
		source,
		destination: join(dir, "sandbox"),
		copyFiles: ["mise.local.toml", "absent.toml"],
	});

	assert.ok(existsSync(join(result.path, "src", "a.txt")));
	assert.equal(readFileSync(join(result.path, "mise.local.toml"), "utf-8"), "secret");
	assert.equal(existsSync(join(result.path, "absent.toml")), false);

	// The clone is independent: writing in it leaves the source untouched.
	writeFileSync(join(result.path, "src", "a.txt"), "changed");
	assert.equal(readFileSync(join(source, "src", "a.txt"), "utf-8"), "tracked");
});
