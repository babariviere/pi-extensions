import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { DurableRunBook } from "./durable-run-book.ts";
import { builtinAgent } from "./discovery.ts";
import type { RecoveryPayload } from "./recovery.ts";
import type { AgentResult } from "./agent-run-book.ts";

test("quit pauses a durable admission and reopening attaches its original input and deadline", async () => {
	const directory = await mkdtemp(join(tmpdir(), "durable-recovery-"));
	const payload: RecoveryPayload = {
		requests: [{ agent: builtinAgent(), task: "continue the checkpointed task", index: 0 }],
		context: {
			cwd: directory,
			sessionId: "parent",
			sessionFile: join(directory, "parent.jsonl"),
			runId: "one",
			timeoutMs: 100_000,
		},
		deadlineAt: Date.now() + 100_000,
		workspaces: [],
	};
	let pauses = 0;
	let cancels = 0;
	let reject!: (error: Error) => void;
	let first: DurableRunBook | undefined;
	let second: DurableRunBook | undefined;
	try {
		first = await DurableRunBook.open(await openNodeJsonlStorage(directory, BACKGROUND_CONTEXT));
		await first.register({
			runId: "one",
			agents: ["task"],
			recovery: payload,
			promise: new Promise((_resolve, fail) => {
				reject = fail;
			}),
			cancel: () => {
				cancels++;
			},
			pause: () => {
				pauses++;
				reject(new Error("worker paused"));
			},
		});
		const startedAt = first.list()[0]!.startedAt;
		await first.close({ preserveRuns: true });
		assert.equal(pauses, 1);
		assert.equal(cancels, 0);
		let resumed: RecoveryPayload | undefined;
		let finish!: (result: AgentResult[]) => void;
		second = await DurableRunBook.open(await openNodeJsonlStorage(directory, BACKGROUND_CONTEXT), {
			resume: (input, id) => {
				assert.equal(id, "one");
				resumed = input;
				return {
					promise: new Promise((resolve) => {
						finish = resolve;
					}),
					cancel: () => {},
				};
			},
		});
		assert.deepEqual(resumed, payload);
		assert.equal(second.list()[0]!.startedAt, startedAt);
		assert.equal(second.list()[0]!.state, "running");
		finish([
			{
				agent: "task",
				ok: true,
				state: "done",
				output: "checkpoint resumed",
				runId: "one",
				conversationId: "child",
			},
		]);
		const settled = await second.wait("one", 1_000);
		assert.equal(settled.results?.[0]?.conversationId, "child");
		assert.equal(settled.results?.[0]?.output, "checkpoint resumed");
	} finally {
		await first?.close();
		await second?.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("recovery snapshots are deep-copied at admission, never expose caller mutation", async () => {
	const directory = await mkdtemp(join(tmpdir(), "durable-input-"));
	let book: DurableRunBook | undefined;
	try {
		book = await DurableRunBook.open(await openNodeJsonlStorage(directory, BACKGROUND_CONTEXT));
		const input: RecoveryPayload = {
			requests: [{ agent: builtinAgent(), task: "original", index: 0 }],
			context: {
				cwd: directory,
				runId: "copy",
				sessionId: "p",
				sessionFile: join(directory, "p"),
				timeoutMs: 10_000,
			},
			deadlineAt: Date.now() + 10_000,
			workspaces: [],
		};
		let finish!: () => void;
		await book.register({
			runId: "copy",
			agents: ["task"],
			recovery: input,
			promise: new Promise<AgentResult[]>((resolve) => {
				finish = () => resolve([]);
			}),
			cancel() {},
			pause: () => finish(),
		});
		input.requests[0]!.task = "mutated";
		await book.close({ preserveRuns: true });
		book = await DurableRunBook.open(await openNodeJsonlStorage(directory, BACKGROUND_CONTEXT), {
			resume: (snapshot) => {
				assert.equal(snapshot.requests[0]!.task, "original");
				return { promise: Promise.resolve([]), cancel() {} };
			},
		});
		await book.wait("copy", 1_000);
	} finally {
		await book?.close();
		await rm(directory, { recursive: true, force: true });
	}
});
