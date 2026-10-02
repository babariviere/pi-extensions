import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { normalizeClefConfig } from "./config.ts";
import { ClefWorker } from "./worker.ts";

const fixture = fileURLToPath(new URL("./fixtures/worker.mjs", import.meta.url));
const makeWorker = (idleTimeoutMs = 60_000) =>
	new ClefWorker(normalizeClefConfig({ idleTimeoutMs, requestTimeoutMs: 5000 }), {
		executable: process.execPath,
		args: [fixture],
	});
interface Reply {
	pid: number;
	sequence: number;
	payload: unknown;
}
const request = async (worker: ClefWorker, payload: unknown = {}) => (await worker.request(payload)) as Reply;
const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
async function waitFor(predicate: () => boolean): Promise<void> {
	for (let i = 0; i < 300; i++) {
		if (predicate()) return;
		await sleep(10);
	}
	assert.fail("condition did not settle");
}

test("lazy startup, process reuse, serialized requests and fragmented responses", async (t) => {
	const worker = makeWorker();
	t.after(() => worker.dispose());
	assert.equal(worker.status, "unloaded");
	const replies = await Promise.all([
		request(worker, { delayMs: 40 }),
		request(worker, { testMode: "partial" }),
		request(worker, { third: true }),
	]);
	assert.deepEqual(
		replies.map((reply) => reply.sequence),
		[1, 2, 3],
	);
	assert.equal(new Set(replies.map((reply) => reply.pid)).size, 1);
	assert.deepEqual(replies[2].payload, { third: true });
	await worker.dispose();
	assert.equal(worker.status, "stopped");
	assert.equal(alive(replies[0].pid), false);
	await assert.rejects(worker.request({}), /stopped/);
});

test("idle unload releases memory and next call starts a fresh worker", async (t) => {
	const worker = makeWorker(50);
	t.after(() => worker.dispose());
	const first = await request(worker);
	await waitFor(() => !alive(first.pid));
	assert.equal(worker.status, "unloaded");
	const next = await request(worker);
	assert.notEqual(first.pid, next.pid);
	assert.equal(next.sequence, 1);
});

test("aborting queued work does not kill active inference", async (t) => {
	const worker = makeWorker();
	t.after(() => worker.dispose());
	const initial = await request(worker);
	const active = request(worker, { delayMs: 150 });
	const abort = new AbortController();
	const rejected = assert.rejects(worker.request({}, { signal: abort.signal }), /aborted/);
	abort.abort();
	await rejected;
	assert.equal((await active).pid, initial.pid);
	assert.equal((await request(worker)).sequence, 3);
});

test("active abort kills the old process before queued work restarts", async (t) => {
	const worker = makeWorker();
	t.after(() => worker.dispose());
	const first = await request(worker);
	const abort = new AbortController();
	const rejected = assert.rejects(worker.request({ testMode: "hang" }, { signal: abort.signal }), /aborted/);
	await waitFor(() => worker.status.startsWith("busy"));
	const next = request(worker);
	abort.abort();
	await rejected;
	const reply = await next;
	assert.equal(alive(first.pid), false);
	assert.notEqual(reply.pid, first.pid);
	assert.equal(reply.sequence, 1);
});

test("timeouts include queue wait and do not cancel unrelated active work", async (t) => {
	const worker = makeWorker();
	t.after(() => worker.dispose());
	const first = await request(worker);
	const active = request(worker, { delayMs: 150 });
	await assert.rejects(worker.request({}, { timeoutMs: 30 }), /timed out/);
	assert.equal((await active).pid, first.pid);
	await assert.rejects(worker.request({ testMode: "hang" }, { timeoutMs: 30 }), /timed out/);
	assert.notEqual((await request(worker)).pid, first.pid);
});

test("explicit unload cancels active and queued calls and is idempotent", async (t) => {
	const worker = makeWorker();
	t.after(() => worker.dispose());
	const first = await request(worker);
	const active = assert.rejects(worker.request({ testMode: "hang" }), /unloaded/);
	await waitFor(() => worker.status.startsWith("busy"));
	const queued = assert.rejects(worker.request({}), /unloaded/);
	await worker.unload();
	await Promise.all([active, queued]);
	assert.equal(alive(first.pid), false);
	await worker.unload();
	assert.equal(worker.status, "unloaded");
	assert.equal((await request(worker)).sequence, 1);
});

test("worker failures are actionable and future calls can recover", async (t) => {
	for (const testMode of ["malformed", "wrongId", "crash", "oversize", "fatal"]) {
		const worker = makeWorker();
		t.after(() => worker.dispose());
		await assert.rejects(worker.request({ testMode }), /invalid JSON-lines|exited|exceeds|Mock failure/);
		assert.equal((await request(worker)).sequence, 1);
		await worker.dispose();
	}
	const worker = makeWorker();
	t.after(() => worker.dispose());
	await assert.rejects(worker.request({ testMode: "error" }), /Mock failure/);
	assert.equal((await request(worker)).sequence, 2);
});

test("missing executable, invalid deadlines, pre-aborts and oversized requests fail safely", async (t) => {
	const worker = new ClefWorker(normalizeClefConfig({}), { executable: "/no-such-clef-python", args: [] });
	t.after(() => worker.dispose());
	await assert.rejects(worker.request({}), /Cannot start/);
	await worker.dispose();
	const lazy = makeWorker();
	t.after(() => lazy.dispose());
	await assert.rejects(lazy.request({}, { timeoutMs: 0 }), /timeoutMs/);
	await assert.rejects(lazy.request({}, { signal: AbortSignal.abort() }), /aborted/);
	await assert.rejects(lazy.request({ text: "x".repeat(4 * 1024 * 1024) }), /exceeds/);
	assert.equal(lazy.status, "unloaded");
});

test("bounded queue rejects excess work and shutdown settles every call", async (t) => {
	const worker = makeWorker();
	t.after(() => worker.dispose());
	await request(worker);
	const active = worker.request({ testMode: "hang" }).catch((error: Error) => error);
	await waitFor(() => worker.status.startsWith("busy"));
	const queued = Array.from({ length: 16 }, () => worker.request({}).catch((error: Error) => error));
	await assert.rejects(worker.request({}), /queue is full/);
	await worker.dispose();
	for (const result of await Promise.all([active, ...queued])) assert.ok(result instanceof Error);
});

test("unresponsive workers are force-killed during unloading", async (t) => {
	const worker = makeWorker();
	t.after(() => worker.dispose());
	const first = await request(worker, { testMode: "ignoreTerm" });
	await worker.unload();
	assert.equal(alive(first.pid), false);
	assert.equal(worker.status, "unloaded");
});
