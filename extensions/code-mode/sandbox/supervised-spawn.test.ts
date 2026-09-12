import assert from "node:assert/strict";
import { test } from "node:test";
import { supervisedSpawn } from "./supervised-spawn.ts";

const cwd = process.cwd();
const chunksOf = () => {
	const chunks: Buffer[] = [];
	return { onData: (data: Buffer) => chunks.push(data), text: () => Buffer.concat(chunks).toString("utf8") };
};

test("resolves the exit code and streams stdout and stderr", async () => {
	const out = chunksOf();
	const res = await supervisedSpawn({ command: "echo out; echo err 1>&2", cwd, onData: out.onData });
	assert.equal(res.exitCode, 0);
	assert.match(out.text(), /out/);
	assert.match(out.text(), /err/);
});

test("reports a non-zero exit code", async () => {
	const res = await supervisedSpawn({ command: "exit 3", cwd, onData: () => {} });
	assert.equal(res.exitCode, 3);
});

test("pipes stdin to the command", async () => {
	const out = chunksOf();
	const res = await supervisedSpawn({ command: "cat", cwd, onData: out.onData, stdin: "hello\nstdin" });
	assert.equal(res.exitCode, 0);
	assert.equal(out.text(), "hello\nstdin");
});

test("tolerates a command that never reads stdin", async () => {
	const res = await supervisedSpawn({ command: "true", cwd, onData: () => {}, stdin: "ignored" });
	assert.equal(res.exitCode, 0);
});

test("passes an explicit environment", async () => {
	const out = chunksOf();
	const res = await supervisedSpawn({
		command: 'printf %s "$SPINDLE_SPAWN_PROBE"',
		cwd,
		onData: out.onData,
		env: { ...process.env, SPINDLE_SPAWN_PROBE: "carried" },
	});
	assert.equal(res.exitCode, 0);
	assert.equal(out.text(), "carried");
});

test("a timeout kills the tree and reports timeout:<seconds>", async () => {
	const startedAt = Date.now();
	await assert.rejects(supervisedSpawn({ command: "sleep 30", cwd, onData: () => {}, timeout: 1 }), /timeout:1/);
	assert.ok(Date.now() - startedAt < 10_000, "the tree must die at the deadline, not be awaited");
});

test("a timeout kills the whole process group, not just bash", async () => {
	const startedAt = Date.now();
	// Both sleeps share the spawned stdout pipe, and the promise only settles
	// once every holder of it is gone: a quick rejection proves the background
	// child died with the group instead of surviving as an orphan.
	await assert.rejects(
		supervisedSpawn({ command: "sleep 30 & sleep 30", cwd, onData: () => {}, timeout: 1 }),
		/timeout:1/,
	);
	assert.ok(Date.now() - startedAt < 10_000, "the background child must die with the group");
});

test("abort kills the tree and reports aborted", async () => {
	const controller = new AbortController();
	const promise = supervisedSpawn({ command: "sleep 30", cwd, onData: () => {}, signal: controller.signal });
	setTimeout(() => controller.abort(), 100);
	await assert.rejects(promise, /aborted/);
});
