import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentRunBook, type AgentCompletionEvent, SETTLED_HISTORY, type SpindleAgentResult } from "./agent-run-book.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Announce delay used by the tests, so they wait milliseconds, not 150ms. */
const ANNOUNCE_MS = 5;
const bookWithSink = (announced: AgentCompletionEvent[]): AgentRunBook => {
	const book = new AgentRunBook({ announceDelayMs: ANNOUNCE_MS });
	book.setSink((event) => void announced.push(event));
	return book;
};

const result = (agent: string, runId: string, ok = true): SpindleAgentResult => ({
	agent,
	ok,
	output: `${agent} output`,
	state: ok ? "done" : "failed",
	runId,
});

const stateOf = (book: AgentRunBook, runId: string): string | undefined =>
	book.list().find((batch) => batch.runId === runId)?.state;

/** A batch whose settling the test controls. */
const deferred = () => {
	let settle: (results: SpindleAgentResult[]) => void = () => {};
	let reject: (error: unknown) => void = () => {};
	const promise = new Promise<SpindleAgentResult[]>((resolve, rejectPromise) => {
		settle = resolve;
		reject = rejectPromise;
	});
	return { promise, settle, reject };
};

test("a wait that expires reports the batch as running instead of failing", async () => {
	const book = new AgentRunBook({ announceDelayMs: ANNOUNCE_MS });
	const batch = deferred();
	let cancelled = 0;
	let detached = 0;
	book.register({
		runId: "r1",
		agents: ["worker"],
		promise: batch.promise,
		cancel: () => void cancelled++,
		onDetach: () => void detached++,
	});

	const outcome = await book.wait("r1", 10);
	assert.equal(outcome.state, "running");
	assert.equal(outcome.results, undefined);
	assert.equal(outcome.snapshot.detached, true);
	assert.equal(detached, 1, "an expired wait drops the parent-turn link");
	assert.equal(cancelled, 0, "an expired wait must not kill the run");

	batch.settle([result("worker", "r1")]);
	await sleep(0);
	const resumed = await book.wait("r1", 1_000);
	assert.equal(resumed.state, "settled");
	assert.equal(resumed.results?.[0]?.output, "worker output");
	assert.equal(resumed.results?.[0]?.state, "done");
	assert.equal(resumed.results?.[0]?.runId, "r1");
});

test("a claimed result is never announced to the session", async () => {
	const announced: AgentCompletionEvent[] = [];
	const book = bookWithSink(announced);
	const batch = deferred();
	book.register({ runId: "r2", agents: ["planner"], promise: batch.promise, cancel: () => {} });

	const waiting = book.wait("r2", 1_000);
	batch.settle([result("planner", "r2")]);
	const outcome = await waiting;
	assert.equal(outcome.state, "settled");
	await sleep(ANNOUNCE_MS * 6);
	assert.deepEqual(announced, []);
});

test("an unclaimed result is announced once the wait window is gone", async () => {
	const announced: AgentCompletionEvent[] = [];
	const book = bookWithSink(announced);
	const batch = deferred();
	book.register({ runId: "r3", agents: ["worker"], promise: batch.promise, cancel: () => {} });

	assert.equal((await book.wait("r3", 10)).state, "running");
	batch.settle([result("worker", "r3")]);
	await sleep(ANNOUNCE_MS * 6);
	assert.equal(announced.length, 1);
	assert.equal(announced[0]?.runId, "r3");
	assert.equal(announced[0]?.results[0]?.agent, "worker");
});

test("a result that settled with no sink is announced when one is installed", async () => {
	const book = new AgentRunBook({ announceDelayMs: ANNOUNCE_MS });
	const batch = deferred();
	book.register({ runId: "r7", agents: ["worker"], promise: batch.promise, cancel: () => {} });
	assert.equal((await book.wait("r7", 10)).state, "running");
	batch.settle([result("worker", "r7")]);
	await sleep(ANNOUNCE_MS * 6);

	const announced: AgentCompletionEvent[] = [];
	book.setSink((event) => void announced.push(event));
	assert.equal(announced.length, 1, "the result is not lost while no sink exists");
	assert.equal(announced[0]?.runId, "r7");
});

test("a batch that settles while a caller is blocked is not announced twice", async () => {
	const announced: AgentCompletionEvent[] = [];
	const book = bookWithSink(announced);
	const batch = deferred();
	book.register({ runId: "r8", agents: ["a", "b"], promise: batch.promise, cancel: () => {} });

	// Two concurrent waiters: both see the results, nothing is announced.
	const first = book.wait("r8", 1_000);
	const second = book.wait("r8", 1_000);
	batch.settle([result("a", "r8"), result("b", "r8")]);
	const [left, right] = await Promise.all([first, second]);
	assert.equal(left.results?.length, 2);
	assert.equal(right.results?.length, 2);
	await sleep(ANNOUNCE_MS * 6);
	assert.deepEqual(announced, []);
});

test("a rejected backend still settles the batch as a failed result", async () => {
	const book = new AgentRunBook({ announceDelayMs: ANNOUNCE_MS });
	const batch = deferred();
	book.register({ runId: "r4", agents: ["worker"], promise: batch.promise, cancel: () => {} });
	batch.reject(new Error("herdr exploded"));
	const outcome = await book.wait("r4", 1_000);
	assert.equal(outcome.state, "settled");
	assert.equal(outcome.results?.[0]?.ok, false);
	assert.equal(outcome.results?.[0]?.state, "failed");
	assert.equal(outcome.results?.[0]?.error, "herdr exploded");
});

test("cancel tears the batch down, reports it at once, and suppresses the announcement", async () => {
	const announced: AgentCompletionEvent[] = [];
	const book = bookWithSink(announced);
	const batch = deferred();
	let cancelled = 0;
	book.register({ runId: "r5", agents: ["worker"], promise: batch.promise, cancel: () => void cancelled++ });

	assert.deepEqual(book.cancel("r5"), ["r5"]);
	assert.equal(cancelled, 1);
	// Reported as cancelled before the child has actually died.
	assert.equal(stateOf(book, "r5"), "cancelled");
	assert.equal((await book.wait("r5", 0)).state, "cancelled");

	batch.settle([result("worker", "r5", false)]);
	await sleep(ANNOUNCE_MS * 6);
	assert.deepEqual(announced, []);
	assert.equal(stateOf(book, "r5"), "cancelled");
});

test("status omits results so a settled history cannot flood the caller", async () => {
	const book = new AgentRunBook({ announceDelayMs: ANNOUNCE_MS });
	const batch = deferred();
	book.register({ runId: "r9", agents: ["worker"], promise: batch.promise, cancel: () => {} });
	batch.settle([result("worker", "r9")]);
	const outcome = await book.wait("r9", 1_000);
	assert.equal(outcome.results?.length, 1, "wait still carries the results");
	assert.equal(book.list()[0]?.results, undefined);
});

test("settled batches age out beyond the history window", async () => {
	const book = new AgentRunBook({ announceDelayMs: ANNOUNCE_MS });
	const total = SETTLED_HISTORY + 3;
	for (let index = 0; index < total; index++) {
		const runId = `p${index}`;
		const batch = deferred();
		book.register({ runId, agents: ["worker"], promise: batch.promise, cancel: () => {} });
		batch.settle([result("worker", runId)]);
		await sleep(0);
	}
	assert.equal(book.list().length, SETTLED_HISTORY);
	assert.equal(stateOf(book, "p0"), undefined, "the oldest settled batch is evicted");
	assert.equal(stateOf(book, `p${total - 1}`), "settled");
});

test("reset cancels every live batch (session teardown)", () => {
	const book = new AgentRunBook({ announceDelayMs: ANNOUNCE_MS });
	const first = deferred();
	const second = deferred();
	const cancelled: string[] = [];
	book.register({ runId: "a", agents: ["x"], promise: first.promise, cancel: () => void cancelled.push("a") });
	book.register({ runId: "b", agents: ["y"], promise: second.promise, cancel: () => void cancelled.push("b") });
	book.reset();
	assert.deepEqual(cancelled.sort(), ["a", "b"]);
	assert.deepEqual(book.list(), []);
});

test("drain cancels, waits for the children, and reports a timeout", async () => {
	const book = new AgentRunBook({ announceDelayMs: ANNOUNCE_MS });
	const quick = deferred();
	let cancelled = 0;
	book.register({
		runId: "d1",
		agents: ["worker"],
		promise: quick.promise,
		cancel: () => {
			cancelled++;
			quick.settle([result("worker", "d1", false)]);
		},
	});
	assert.equal(await book.drain(1_000), true);
	assert.equal(cancelled, 1);
	assert.deepEqual(book.list(), []);

	const stuck = deferred();
	book.register({ runId: "d2", agents: ["worker"], promise: stuck.promise, cancel: () => {} });
	assert.equal(await book.drain(10), false, "a child that ignores the kill reports a timed-out drain");
	stuck.settle([result("worker", "d2", false)]);
});

test("waiting on an unknown run is an error", async () => {
	const book = new AgentRunBook({ announceDelayMs: ANNOUNCE_MS });
	await assert.rejects(() => book.wait("nope", 10), /Unknown subagent run: nope/);
	assert.throws(() => book.cancel("nope"), /Unknown subagent run: nope/);
});

test("waitMs 0 launches without blocking", async () => {
	const book = new AgentRunBook({ announceDelayMs: ANNOUNCE_MS });
	const batch = deferred();
	book.register({ runId: "r6", agents: ["worker"], promise: batch.promise, cancel: () => {} });
	const outcome = await book.wait("r6", 0);
	assert.equal(outcome.state, "running");
	assert.equal(outcome.snapshot.detached, true);
	batch.settle([result("worker", "r6")]);
});
