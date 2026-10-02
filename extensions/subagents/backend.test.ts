import assert from "node:assert/strict";
import { test } from "node:test";
import { RunLauncher } from "./backend.ts";
import { builtinAgent } from "./discovery.ts";
import type { RunBackend, RunContext, RunRequest, RunResult } from "./run.ts";

const request = (): RunRequest => ({ agent: builtinAgent(), task: "work", index: 0 });
const context = (): RunContext => ({
	sessionId: "parent",
	sessionFile: "/tmp/parent.jsonl",
	runId: "launcher-test",
	cwd: process.cwd(),
	timeoutMs: 1_000,
});

test("the launcher always selects durable and forwards requests and context unchanged", async () => {
	const requests = [request()];
	const ctx = context();
	const results: RunResult[] = [
		{
			agent: "task",
			scope: "builtin",
			ok: true,
			output: "done",
			backend: "durable",
			conversationId: "conversation-1",
		},
	];
	let calls = 0;
	const launcher = new RunLauncher(async (received, ambient) => {
		calls++;
		assert.equal(received, requests);
		assert.equal(ambient, ctx);
		return results;
	});
	assert.deepEqual(await launcher.selection(), { backend: "durable" });
	assert.equal(calls, 0, "selection must not execute a child");
	assert.equal(await launcher.run(requests, ctx), results);
	assert.equal(calls, 1);
});

test("replacement serves new calls while active calls finish on the original backend", async () => {
	let finish!: (results: RunResult[]) => void;
	const calls: string[] = [];
	const first: RunBackend = () => {
		calls.push("v1");
		return new Promise((resolve) => {
			finish = resolve;
		});
	};
	const launcher = new RunLauncher(first);
	const active = launcher.run([request()], context());
	try {
		launcher.replace(async () => {
			calls.push("v2");
			return [];
		});
		assert.deepEqual(await launcher.run([request()], context()), []);
		assert.deepEqual(calls, ["v1", "v2"]);
		assert.deepEqual(await launcher.selection(), { backend: "durable" });
	} finally {
		finish([]);
		await active;
	}
});

test("backend rejection is surfaced without selecting or launching a fallback", async () => {
	const failure = new Error("durable worker unavailable");
	let calls = 0;
	const launcher = new RunLauncher(async () => {
		calls++;
		throw failure;
	});
	await assert.rejects(launcher.run([request()], context()), (error) => error === failure);
	assert.deepEqual(await launcher.selection(), { backend: "durable" });
	assert.equal(calls, 1);
});

test("launch failures remain durable results rather than triggering a legacy fallback", async () => {
	const result: RunResult = {
		agent: "task",
		scope: "builtin",
		ok: false,
		output: "",
		backend: "durable",
		error: "worker failed to start",
		failure: "launch",
	};
	let calls = 0;
	const launcher = new RunLauncher(async () => {
		calls++;
		return [result];
	});
	assert.deepEqual(await launcher.run([request()], context()), [result]);
	assert.deepEqual(await launcher.run([request()], context()), [result]);
	assert.equal(calls, 2);
	assert.deepEqual(await launcher.selection(), { backend: "durable" });
});
