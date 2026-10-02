import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MemoryStorage, type Storage, type StorageWrite } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";

import type { AgentBatchRegistration, AgentCompletionEvent, AgentResult } from "./agent-run-book.ts";
import { DurableRunBook } from "./durable-run-book.ts";

const ANNOUNCE_MS = 5;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (predicate: () => boolean): Promise<void> => {
	for (let tries = 0; tries < 100 && !predicate(); tries++) await sleep(2);
	assert.equal(predicate(), true, "condition did not become true");
};

const result = (runId: string, agent = "worker"): AgentResult => ({
	agent,
	ok: true,
	output: `${agent} output`,
	state: "done",
	runId,
});

const deferred = () => {
	let resolve!: (value: AgentResult[]) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<AgentResult[]>((accept, fail) => {
		resolve = accept;
		reject = fail;
	});
	return { promise, resolve, reject };
};

class ObservedMemoryStorage extends MemoryStorage {
	commits: Array<readonly StorageWrite[]> = [];
	failNext: Error | undefined;
	beforeCommit: (() => Promise<void>) | undefined;
	afterCommit: (() => void) | undefined;

	override async commit(writes: readonly StorageWrite[], context: Parameters<Storage["commit"]>[1]) {
		const before = this.beforeCommit;
		this.beforeCommit = undefined;
		await before?.();
		if (this.failNext) {
			const error = this.failNext;
			this.failNext = undefined;
			throw error;
		}
		const seq = await super.commit(writes, context);
		this.commits = [...this.commits, writes];
		this.afterCommit?.();
		return seq;
	}
}

const registration = (
	runId: string,
	batch: ReturnType<typeof deferred>,
	extra: Partial<AgentBatchRegistration> = {},
): AgentBatchRegistration => ({
	runId,
	agents: ["worker"],
	promise: batch.promise,
	cancel: () => {},
	...extra,
});

const openJsonl = async (directory: string): Promise<Storage> =>
	openNodeJsonlStorage(directory, BACKGROUND_CONTEXT, { fsync: false });

test("admission and cancellation are committed before registration acceptance and child kill", async () => {
	const storage = new ObservedMemoryStorage();
	const book = await DurableRunBook.open(storage, { announceDelayMs: ANNOUNCE_MS });
	const batch = deferred();
	let commitsWhenKilled = 0;
	await book.register(
		registration("admission", batch, {
			cancel: () => {
				commitsWhenKilled = storage.commits.length;
			},
		}),
	);
	assert.equal(storage.commits.length, 2, "journal initialization and admission have committed");
	assert.equal(book.list()[0]?.state, "running");
	assert.deepEqual(await book.cancel("admission"), ["admission"]);
	assert.equal(commitsWhenKilled, 3, "the cancellation receipt was committed before kill");
	assert.match(JSON.stringify(storage.commits.at(-1)), /cancelled/);
	assert.equal((await book.wait("admission", 0)).state, "cancelled");
	batch.resolve([result("admission")]);
	await book.drain(1_000);
	await book.close();
});

test("terminal output and the delivery receipt commit before sink publication", async () => {
	const storage = new ObservedMemoryStorage();
	const book = await DurableRunBook.open(storage, { announceDelayMs: ANNOUNCE_MS });
	const batch = deferred();
	await book.register(registration("publish", batch));
	assert.equal(storage.commits.length, 2);
	const announced: AgentCompletionEvent[] = [];
	let commitsAtSink = 0;
	book.setSink((event) => {
		announced.push(event);
		commitsAtSink = storage.commits.length;
	});
	await book.wait("publish", 0);
	batch.resolve([result("publish")]);
	for (let tries = 0; tries < 100 && announced.length === 0; tries++) await sleep(2);
	assert.equal(announced.length, 1);
	assert.equal(commitsAtSink, 5, "terminal results and the delivery receipt both precede invocation");
	assert.equal((await book.wait("publish", 0)).results?.[0]?.output, "worker output");
	await sleep(ANNOUNCE_MS * 3);
	assert.equal(announced.length, 1, "repeated waits and flushes cannot announce twice");
	await book.close();
});

test("terminal results remain waitable after a JSONL restart with their original start time", async () => {
	const directory = await mkdtemp(join(tmpdir(), "durable-run-book-"));
	try {
		const book = await DurableRunBook.open(await openJsonl(directory));
		const batch = deferred();
		await book.register(registration("restart-terminal", batch));
		const startedAt = book.list()[0]?.startedAt;
		const waiting = book.wait("restart-terminal", 1_000);
		batch.resolve([result("restart-terminal")]);
		assert.equal((await waiting).results?.[0]?.output, "worker output");
		await book.close();

		const reopened = await DurableRunBook.open(await openJsonl(directory));
		const record = reopened.list()[0];
		assert.equal(record?.startedAt, startedAt);
		assert.equal((await reopened.wait("restart-terminal", 0)).results?.[0]?.runId, "restart-terminal");
		await reopened.close();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("cancelled and interrupted runs recover without relaunching external effects", async () => {
	const directory = await mkdtemp(join(tmpdir(), "durable-run-book-recovery-"));
	try {
		let storage = await openJsonl(directory);
		let book = await DurableRunBook.open(storage);
		const cancelled = deferred();
		let killed = 0;
		await book.register(registration("cancelled-recovery", cancelled, { cancel: () => killed++ }));
		const cancelledStartedAt = book.list()[0]?.startedAt;
		assert.deepEqual(await book.cancel("cancelled-recovery"), ["cancelled-recovery"]);
		assert.equal(killed, 1);
		await book.suspend();
		await storage.close(BACKGROUND_CONTEXT);

		storage = await openJsonl(directory);
		book = await DurableRunBook.open(storage);
		const cancelledOutcome = await book.wait("cancelled-recovery", 0);
		assert.equal(cancelledOutcome.state, "cancelled");
		assert.match(cancelledOutcome.results?.[0]?.error ?? "", /cancelled before process restart/);
		assert.equal(book.list().find((item) => item.runId === "cancelled-recovery")?.startedAt, cancelledStartedAt);

		const interrupted = deferred();
		await book.register(registration("interrupted", interrupted));
		const interruptedStartedAt = book.list().find((item) => item.runId === "interrupted")?.startedAt;
		await book.suspend();
		await storage.close(BACKGROUND_CONTEXT);

		book = await DurableRunBook.open(await openJsonl(directory));
		const recovered = await book.wait("interrupted", 0);
		assert.equal(recovered.state, "settled");
		assert.equal(recovered.results?.[0]?.state, "failed");
		assert.match(recovered.results?.[0]?.error ?? "", /not automatically relaunched/);
		assert.equal(book.list().find((item) => item.runId === "interrupted")?.startedAt, interruptedStartedAt);
		await book.close();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("delivery receipts survive restart and prevent duplicate announcements", async () => {
	const directory = await mkdtemp(join(tmpdir(), "durable-run-book-delivery-"));
	try {
		const book = await DurableRunBook.open(await openJsonl(directory), { announceDelayMs: ANNOUNCE_MS });
		const batch = deferred();
		await book.register(registration("delivered", batch));
		const first: AgentCompletionEvent[] = [];
		book.setSink((event) => first.push(event));
		await book.wait("delivered", 0);
		batch.resolve([result("delivered")]);
		for (let tries = 0; tries < 100 && first.length === 0; tries++) await sleep(2);
		assert.equal(first.length, 1);
		await book.close();

		const reopened = await DurableRunBook.open(await openJsonl(directory));
		const second: AgentCompletionEvent[] = [];
		reopened.setSink((event) => second.push(event));
		await reopened.flushCompletions();
		assert.deepEqual(second, [], "a committed delivery receipt suppresses replay");
		assert.equal((await reopened.wait("delivered", 0)).results?.length, 1);
		await reopened.close();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("suspension detaches callbacks and a replacement sink receives later completions", async () => {
	const book = await DurableRunBook.open(new MemoryStorage(), { announceDelayMs: ANNOUNCE_MS });
	const batch = deferred();
	let detached = 0;
	const oldSink: AgentCompletionEvent[] = [];
	const newSink: AgentCompletionEvent[] = [];
	await book.register(registration("reload", batch, { onDetach: () => detached++ }));
	book.setSink((event) => oldSink.push(event));
	await book.suspend();
	assert.equal(detached, 1);
	book.setAnnounceWhen(() => true);
	book.setSink((event) => newSink.push(event));
	batch.resolve([result("reload")]);
	for (let tries = 0; tries < 100 && newSink.length === 0; tries++) await sleep(2);
	assert.deepEqual(oldSink, []);
	assert.equal(newSink.length, 1);
	assert.equal(detached, 1, "an invoked detach callback is not retained or invoked again");
	await book.close();
});

test("concurrent and repeated waits all claim the same terminal result without announcing it", async () => {
	const book = await DurableRunBook.open(new MemoryStorage(), { announceDelayMs: ANNOUNCE_MS });
	const batch = deferred();
	const announced: AgentCompletionEvent[] = [];
	await book.register(registration("concurrent", batch));
	book.setSink((event) => announced.push(event));
	const first = book.wait("concurrent", 1_000);
	const second = book.wait("concurrent", 1_000);
	batch.resolve([result("concurrent")]);
	const [left, right] = await Promise.all([first, second]);
	assert.equal(left.results?.[0]?.output, "worker output");
	assert.equal(right.results?.[0]?.output, "worker output");
	assert.equal((await book.wait("concurrent", 0)).results?.[0]?.runId, "concurrent");
	await sleep(ANNOUNCE_MS * 3);
	assert.deepEqual(announced, []);
	await book.close();
});

test("reload releases obsolete waiters without cancelling or claiming the replacement's result", async () => {
	const book = await DurableRunBook.open(new MemoryStorage(), { announceDelayMs: ANNOUNCE_MS });
	const batch = deferred();
	let cancelled = false;
	await book.register(
		registration("old-waiter", batch, {
			cancel: () => {
				cancelled = true;
			},
		}),
	);
	const obsolete = book.wait("old-waiter", 60_000);
	await Promise.resolve();
	await book.suspend();
	assert.equal((await obsolete).state, "running");
	assert.equal(cancelled, false);
	const current = book.wait("old-waiter", 1_000);
	batch.resolve([result("old-waiter")]);
	assert.equal((await current).results?.[0]?.output, "worker output");
	await book.close();
});

test("claimed history is bounded but live and unclaimed results are preserved", async () => {
	const book = await DurableRunBook.open(new MemoryStorage());
	for (let index = 0; index < 53; index++) {
		const runId = `history-${index}`;
		const batch = deferred();
		await book.register(registration(runId, batch));
		batch.resolve([result(runId)]);
		assert.equal((await book.wait(runId, 1_000)).results?.[0]?.runId, runId);
	}
	assert.equal(book.list().length, 50);
	assert.equal(
		book.list().some((item) => item.runId === "history-0"),
		false,
	);

	const unclaimed = deferred();
	await book.register(registration("unclaimed-history", unclaimed));
	unclaimed.resolve([result("unclaimed-history")]);
	await book.wait("unclaimed-history", 1_000);
	const live = deferred();
	await book.register(
		registration("live-history", live, {
			cancel: () => live.resolve([{ ...result("live-history"), ok: false, state: "failed" }]),
		}),
	);
	const waitable = deferred();
	await book.register(registration("unclaimed-result", waitable));
	waitable.resolve([result("unclaimed-result")]);
	await waitFor(() => book.list().find((item) => item.runId === "unclaimed-result")?.state === "settled");
	// Keep the terminal output unclaimed while additional claimed records exercise pruning.
	const newest = deferred();
	await book.register(
		registration("newest-live", newest, {
			cancel: () => newest.resolve([{ ...result("newest-live"), ok: false, state: "failed" }]),
		}),
	);
	assert.ok(book.list().some((item) => item.runId === "live-history"));
	assert.ok(book.list().some((item) => item.runId === "newest-live"));
	assert.ok(book.list().some((item) => item.runId === "unclaimed-result"));
	await book.suspend();
	await book.close();
});

test("a journal failure fails closed, rejects waiters, and cancels live children", async () => {
	const storage = new ObservedMemoryStorage();
	const reported: Error[] = [];
	const book = await DurableRunBook.open(storage, { onError: (error) => reported.push(error) });
	const batch = deferred();
	let cancelled = 0;
	await book.register(registration("storage-failure", batch, { cancel: () => cancelled++ }));
	const waiting = book.wait("storage-failure", 1_000);
	storage.failNext = new Error("injected journal failure");
	batch.resolve([result("storage-failure")]);
	await assert.rejects(waiting, /injected journal failure/);
	assert.equal(cancelled, 1);
	assert.match(reported[0]?.message ?? "", /injected journal failure/);
	assert.throws(() => book.list(), /injected journal failure/);
	await book.close();
});

test("explicit flush cannot steal a terminal result from an active waiter", async () => {
	const storage = new ObservedMemoryStorage();
	const book = await DurableRunBook.open(storage);
	const batch = deferred();
	const announced: AgentCompletionEvent[] = [];
	await book.register(registration("flush-race", batch));
	book.setSink((event) => announced.push(event));
	let flush: Promise<void> | undefined;
	storage.afterCommit = () => {
		if (storage.commits.length === 3) flush = book.flushCompletions();
	};
	const waiting = book.wait("flush-race", 1_000);
	await Promise.resolve();
	batch.resolve([result("flush-race")]);
	assert.equal((await waiting).results?.[0]?.output, "worker output");
	await flush;
	await book.flushCompletions();
	assert.deepEqual(announced, []);
	await book.close();
});

test("sink replacement during a receipt commit never calls the obsolete observer", async () => {
	const storage = new ObservedMemoryStorage();
	const book = await DurableRunBook.open(storage);
	const batch = deferred();
	await book.register(registration("sink-race", batch));
	book.setAnnounceWhen(() => false);
	const obsolete: AgentCompletionEvent[] = [];
	book.setSink((event) => obsolete.push(event));
	batch.resolve([result("sink-race")]);
	await waitFor(() => book.list()[0]?.state === "settled");
	let entered!: () => void;
	let release!: () => void;
	const ready = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	storage.beforeCommit = async () => {
		entered();
		await gate;
	};
	book.setAnnounceWhen(() => true);
	const flushing = book.flushCompletions();
	await ready;
	await book.suspend();
	const current: AgentCompletionEvent[] = [];
	book.setAnnounceWhen(() => true);
	book.setSink((event) => current.push(event));
	release();
	await flushing;
	await book.flushCompletions();
	assert.deepEqual(obsolete, []);
	assert.deepEqual(current, [], "committed at-most-once receipt prevents duplicate delivery");
	assert.equal((await book.wait("sink-race", 0)).results?.[0]?.output, "worker output");
	await book.close();
});

test("caller and sink mutations cannot change journaled results", async () => {
	const book = await DurableRunBook.open(new MemoryStorage(), { announceDelayMs: ANNOUNCE_MS });
	const batch = deferred();
	await book.register(registration("immutable", batch));
	const original = result("immutable");
	const waiting = book.wait("immutable", 1_000);
	batch.resolve([original]);
	const terminal = await waiting;
	original.output = "mutated input";
	terminal.results![0]!.output = "mutated return";
	terminal.snapshot.results![0]!.output = "mutated snapshot";
	assert.equal((await book.wait("immutable", 0)).results?.[0]?.output, "worker output");
	const background = deferred();
	await book.register(registration("immutable-sink", background));
	let sent = false;
	book.setSink((event) => {
		event.results[0]!.output = "mutated sink";
		sent = true;
	});
	background.resolve([result("immutable-sink")]);
	await waitFor(() => sent);
	assert.equal((await book.wait("immutable-sink", 0)).results?.[0]?.output, "worker output");
	await book.close();
});

test("close bounds an uncooperative runner and ignores its late completion", async () => {
	const storage = new ObservedMemoryStorage();
	const book = await DurableRunBook.open(storage);
	const batch = deferred();
	let killed = 0;
	await book.register(registration("wedged", batch, { cancel: () => killed++ }));
	assert.equal(await book.drain(5), false);
	await book.close();
	assert.equal(killed, 1);
	const commits = storage.commits.length;
	batch.resolve([result("wedged")]);
	await sleep(10);
	assert.equal(storage.commits.length, commits, "closed storage must receive no late writes");
	assert.match(JSON.stringify(storage.commits.at(-1)), /termination was not confirmed/);
	assert.throws(() => book.list(), /closed/);
});
