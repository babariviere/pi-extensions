/**
 * Provider-level tests for `agents.*`: the bounded wait, the run handles, and
 * cancellation, driven through a fake run backend so nothing spawns.
 *
 * The descriptor schemas are checked against the exact payloads GUEST_SETUP
 * emits (see `runtime/quickjs-runtime.ts`), because a schema that rejects a
 * legal guest call only fails at invocation time.
 */

import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { Value } from "typebox/value";

import { RunLauncher } from "../agents/backend.ts";
import type { RunBackend, RunContext, RunResult } from "../agents/run.ts";
import type { SpindleInvocationContext } from "../protocol.ts";
import { AgentRunBook } from "./agent-run-book.ts";
import { SpindleAgentRunRegistry } from "./agent-run-monitor.ts";
import { SpindleAgentsProvider } from "./agents-provider.ts";

const invocationContext = (signal?: AbortSignal): SpindleInvocationContext => ({
	cwd: tmpdir(),
	signal,
	parentToolCallId: "call-1",
	nestedToolCallId: "call-1_nested",
	extensionContext: {} as never,
	update: () => {},
});

interface Harness {
	provider: SpindleAgentsProvider;
	book: AgentRunBook;
	/** The run context the fake backend was invoked with. */
	contextOf: () => RunContext | undefined;
	/** Settle the in-flight batch. */
	settle: (results: RunResult[]) => void;
	/** Runs the fake backend received. */
	count: () => number;
}

const harness = (waitMs = 0): Harness => {
	let runContext: RunContext | undefined;
	let settle: (results: RunResult[]) => void = () => {};
	let count = 0;
	const headless: RunBackend = (reqs, ctx) => {
		runContext = ctx;
		count = reqs.length;
		return new Promise<RunResult[]>((resolve) => {
			settle = resolve;
			// Both real backends resolve their runs when the context is aborted.
			ctx.signal?.addEventListener(
				"abort",
				() =>
					resolve(
						reqs.map((req) => ({
							agent: req.agent.config.name,
							scope: req.agent.scope,
							ok: false,
							output: "",
							backend: "headless" as const,
							error: "cancelled by the parent session",
						})),
					),
				{ once: true },
			);
		});
	};
	const book = new AgentRunBook({ announceDelayMs: 5 });
	const provider = new SpindleAgentsProvider(
		() => ({ sessionId: undefined, sessionFile: undefined, cwd: tmpdir() }),
		new SpindleAgentRunRegistry(),
		() => ({ timeoutMs: 60_000, waitMs }),
		book,
		new RunLauncher({ inHerdr: () => false, headless }),
	);
	return { provider, book, contextOf: () => runContext, settle: (results) => settle(results), count: () => count };
};

const doneResult = (agent: string): RunResult => ({
	agent,
	scope: "user",
	ok: true,
	output: `${agent} finished`,
	backend: "headless",
	exitCode: 0,
});

test("an expired wait window returns a running handle without killing the run", async () => {
	const { provider, contextOf } = harness();
	const result = (await provider.invoke("run", { task: "do a thing" }, invocationContext())) as Record<
		string,
		unknown
	>;
	assert.equal(result.state, "running");
	assert.equal(result.ok, false);
	assert.equal(typeof result.runId, "string");
	assert.equal(contextOf()?.signal?.aborted, false, "handing back a handle must not cancel the child");
});

test("wait resumes a launched batch and returns its settled results", async () => {
	const { provider, settle } = harness();
	const handle = (await provider.invoke("start", { task: "do a thing" }, invocationContext())) as {
		runId: string;
		state: string;
	};
	assert.equal(handle.state, "running");
	settle([doneResult("task")]);
	const waited = (await provider.invoke("wait", { runId: handle.runId, waitMs: 1_000 }, invocationContext())) as {
		state: string;
		results: Array<Record<string, unknown>>;
	};
	assert.equal(waited.state, "settled");
	assert.equal(waited.results[0]?.state, "done");
	assert.equal(waited.results[0]?.output, "task finished");
	assert.equal(waited.results[0]?.runId, handle.runId);
});

test("cancel aborts the run context and reports the batch as cancelled", async () => {
	const { provider, contextOf } = harness();
	const handle = (await provider.invoke("start", { task: "do a thing" }, invocationContext())) as { runId: string };
	const cancelled = (await provider.invoke("cancel", { runId: handle.runId }, invocationContext())) as {
		cancelled: string[];
	};
	assert.deepEqual(cancelled.cancelled, [handle.runId]);
	assert.equal(contextOf()?.signal?.aborted, true);
	const status = (await provider.invoke("status", {}, invocationContext())) as Array<Record<string, unknown>>;
	assert.equal(status.find((batch) => batch.runId === handle.runId)?.state, "cancelled");
});

test("cancelling the parent turn cancels an attached batch", async () => {
	const { provider, contextOf, book } = harness(5_000);
	const controller = new AbortController();
	// Aborted while the caller is still blocked: this is the attached window.
	const pending = provider.invoke("run", { task: "do a thing" }, invocationContext(controller.signal));
	await new Promise((resolve) => setTimeout(resolve, 5));
	controller.abort();
	const result = (await pending) as Record<string, unknown>;
	assert.equal(contextOf()?.signal?.aborted, true);
	assert.equal(result.state, "failed");
	assert.equal(book.list().find((batch) => batch.runId === result.runId)?.state, "cancelled");
});

test("a detached batch survives its launching program", async () => {
	const { provider, contextOf, book } = harness();
	const controller = new AbortController();
	const result = (await provider.invoke("start", { task: "do a thing" }, invocationContext(controller.signal))) as {
		runId: string;
	};
	controller.abort();
	assert.equal(contextOf()?.signal?.aborted, false, "agents.start is not tied to the turn");
	assert.equal(book.list().find((batch) => batch.runId === result.runId)?.state, "running");
	book.cancel(result.runId);
});

test("a batch's timeout is clamped to the configured cap", async () => {
	const { provider, contextOf } = harness();
	await provider.invoke("run", { task: "do a thing", timeoutMs: 99_999_999 }, invocationContext());
	assert.equal(contextOf()?.timeoutMs, 60_000);
});

test("a call with no usable task is rejected instead of spawning", async () => {
	const { provider, count } = harness();
	await assert.rejects(
		() => provider.invoke("start", {}, invocationContext()),
		/requires at least one non-empty task/,
	);
	await assert.rejects(
		() => provider.invoke("run", { task: "   " }, invocationContext()),
		/requires at least one non-empty task/,
	);
	assert.equal(count(), 0);
});

test("runAll launches one batch for every task", async () => {
	const { provider, count } = harness();
	const results = (await provider.invoke(
		"runAll",
		{ tasks: [{ task: "one" }, { task: "two" }], waitMs: 0 },
		invocationContext(),
	)) as Array<Record<string, unknown>>;
	assert.equal(count(), 2);
	assert.equal(results.length, 2);
	assert.equal(results[0]?.state, "running");
});

test("every descriptor schema accepts the payloads the guest can emit", async () => {
	const { provider } = harness();
	const schemaOf = async (action: string): Promise<Record<string, unknown>> => {
		const descriptor = await provider.describe(action, invocationContext());
		assert.ok(descriptor, `missing descriptor: ${action}`);
		return descriptor.inputSchema as Record<string, unknown>;
	};
	const accepts = async (action: string, args: Record<string, unknown>) => {
		const schema = await schemaOf(action);
		assert.ok(Value.Check(schema, args), `${action} rejected ${JSON.stringify(args)}`);
	};
	const rejects = async (action: string, args: Record<string, unknown>) => {
		const schema = await schemaOf(action);
		assert.ok(!Value.Check(schema, args), `${action} accepted ${JSON.stringify(args)}`);
	};

	await accepts("run", { agent: "reviewer", task: "t" });
	await accepts("run", { task: "t", waitMs: 1_000, timeoutMs: 2_000 });
	await accepts("run", { task: "t", reads: ["a.md"], night: true, model: "m", thinking: "high", output: "o.md" });
	await accepts("runAll", { tasks: [{ task: "t" }], waitMs: 1_000, timeoutMs: 2_000 });
	await accepts("start", { task: "t", timeoutMs: 2_000 });
	await accepts("start", { tasks: [{ task: "t" }] });
	await accepts("start", {});
	await accepts("wait", { runId: "r" });
	await accepts("wait", { runId: "r", waitMs: 0 });
	await accepts("status", {});
	await accepts("cancel", {});
	await accepts("cancel", { runId: "r" });

	// Timing is batch-level: a per-task window would be silently ignored.
	await rejects("runAll", { tasks: [{ task: "t", waitMs: 1 }] });
	await rejects("run", { task: "t", unknown: 1 });
	await rejects("wait", {});
});
