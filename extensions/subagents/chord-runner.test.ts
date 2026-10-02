import assert from "node:assert/strict";
import { test } from "node:test";
import { ChordRunner } from "./chord-runner.ts";
import type { RunBackend, RunContext } from "./run.ts";

const emptyContext = (): RunContext => ({
	sessionId: undefined,
	sessionFile: undefined,
	runId: "chord-runner-test",
	cwd: process.cwd(),
	timeoutMs: 1_000,
});

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

test("active calls finish on v1 while v2 serves new calls through the captured run method", async () => {
	const started = deferred<void>();
	const finishV1 = deferred<void>();
	const calls: string[] = [];
	const v1: RunBackend = async () => {
		calls.push("v1-started");
		started.resolve();
		await finishV1.promise;
		calls.push("v1-finished");
		return [];
	};
	const v2: RunBackend = async () => {
		calls.push("v2");
		return [];
	};
	const runner = await ChordRunner.open(v1);
	const capturedRun = runner.run;

	try {
		const activeV1Call = capturedRun([], emptyContext());
		await started.promise;
		await runner.reload(v2);
		await capturedRun([], emptyContext());
		assert.deepEqual(calls, ["v1-started", "v2"]);

		finishV1.resolve();
		await activeV1Call;
		assert.deepEqual(calls, ["v1-started", "v2", "v1-finished"]);
	} finally {
		finishV1.resolve();
		await runner.dispose();
	}
});

test("a failed candidate leaves the current backend available", async () => {
	let calls = 0;
	const backend: RunBackend = async () => {
		calls++;
		return [];
	};
	const runner = await ChordRunner.open(backend);

	try {
		await assert.rejects(runner.reload(null as unknown as RunBackend), TypeError);
		await runner.run([], emptyContext());
		assert.equal(calls, 1);
	} finally {
		await runner.dispose();
	}
});

test("reloads and disposal are serialized, disposal is idempotent, and new calls are rejected", async () => {
	const calls: string[] = [];
	const runner = await ChordRunner.open(async () => {
		calls.push("v1");
		return [];
	});
	const capturedRun = runner.run;

	const v2: RunBackend = async () => {
		calls.push("v2");
		return [];
	};
	const v3: RunBackend = async () => {
		calls.push("v3");
		return [];
	};

	const firstReload = runner.reload(v2);
	const secondReload = runner.reload(v3);
	await Promise.all([firstReload, secondReload]);
	await capturedRun([], emptyContext());
	assert.deepEqual(calls, ["v3"]);

	const lastReload = runner.reload(v2);
	const dispose = runner.dispose();
	assert.equal(runner.dispose(), dispose);
	await assert.rejects(capturedRun([], emptyContext()), /disposed/);
	await Promise.all([lastReload, dispose]);
});
