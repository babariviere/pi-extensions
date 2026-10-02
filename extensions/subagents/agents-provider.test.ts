/**
 * Provider-level tests for `agents.*`: the bounded wait, the run handles, and
 * cancellation, driven through a fake run backend so nothing spawns.
 *
 * The descriptor schemas are checked against supported native tool payloads.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Value } from "typebox/value";

import { RunLauncher } from "./backend.ts";
import { CauseBreaker } from "./cause-breaker.ts";
import type { RunBackend, RunContext, RunRequest, RunResult } from "./run.ts";
import type { ActionContext } from "../shared/action-tools.ts";
import { AgentRunBook } from "./agent-run-book.ts";
import { AgentRunRegistry } from "./agent-run-monitor.ts";
import { bindApprovedNightTasks, AgentsProvider } from "./agents-provider.ts";

const invocationContext = (signal?: AbortSignal): ActionContext => ({
	cwd: tmpdir(),
	signal,
	parentToolCallId: "call-1",
	nestedToolCallId: "call-1_nested",
	extensionContext: {} as never,
	update: () => {},
});

interface Harness {
	provider: AgentsProvider;
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
	const provider = new AgentsProvider(
		() => ({ sessionId: undefined, sessionFile: undefined, cwd: tmpdir() }),
		new AgentRunRegistry(),
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

test("provider close cancels and drains live children, then rejects new calls", async () => {
	const { provider, contextOf } = harness();
	await provider.invoke("start", { task: "do it" }, invocationContext());
	const ctx = contextOf();
	assert.ok(ctx?.signal);
	await provider.close();
	assert.equal(ctx.signal.aborted, true);
	assert.deepEqual(provider.runs.list(), []);
	await assert.rejects(provider.invoke("start", { task: "new" }, invocationContext()), /shutting down/);
});

test("session shutdown during adapter selection cannot launch an orphan child", async () => {
	let release: (verdict: { compatible: boolean }) => void = () => {};
	let probed: () => void = () => {};
	const ready = new Promise<void>((resolve) => {
		probed = resolve;
	});
	let spawned = 0;
	const launcher = new RunLauncher({
		inHerdr: () => true,
		probe: () => {
			probed();
			return new Promise((resolve) => {
				release = resolve;
			});
		},
		headless: async () => {
			spawned++;
			return [];
		},
	});
	const provider = new AgentsProvider(
		() => ({ sessionId: undefined, sessionFile: undefined, cwd: tmpdir() }),
		new AgentRunRegistry(),
		() => ({ timeoutMs: 60_000, waitMs: 0 }),
		new AgentRunBook(),
		launcher,
	);
	const launched = provider.invoke("start", { task: "do it" }, invocationContext());
	const rejected = assert.rejects(launched, /shutting down/);
	await ready;
	await provider.close();
	release({ compatible: false });
	await rejected;
	assert.equal(spawned, 0);
});

test("agent settings take precedence over runtime defaults unless the caller overrides them", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "code-mode-agent-defaults-"));
	try {
		const dir = join(cwd, ".pi", "agents");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ enabledModels: [] }));
		writeFileSync(
			join(dir, "reviewer.md"),
			"---\nname: reviewer\nmodel: parent/reviewer\nthinking: low\n---\nReview.",
		);
		writeFileSync(join(dir, "suffix.md"), "---\nname: suffix\nmodel: parent/reviewer:high\n---\nReview.");
		writeFileSync(join(dir, "worker.md"), "---\nname: worker\n---\nWork.");
		let received: RunRequest[] = [];
		const headless: RunBackend = async (reqs) => {
			received = reqs;
			return reqs.map((req) => doneResult(req.agent.config.name));
		};
		const provider = new AgentsProvider(
			() => ({ cwd, sessionId: undefined, sessionFile: undefined }),
			new AgentRunRegistry(),
			() => ({
				timeoutMs: 60_000,
				waitMs: 1_000,
				parentProvider: "parent",
				defaultModel: "parent/default",
				defaultThinking: "medium",
			}),
			new AgentRunBook(),
			new RunLauncher({ inHerdr: () => false, headless }),
		);
		await provider.invoke(
			"runAll",
			{
				tasks: [
					{ agent: "reviewer", task: "a" },
					{ agent: "suffix", task: "b" },
					{ agent: "worker", task: "c" },
					{ task: "d" },
					{ agent: "reviewer", task: "e", model: "parent/special", thinking: "xhigh" },
				],
			},
			{ ...invocationContext(), cwd },
		);
		assert.deepEqual(
			received.map((req) => ({ name: req.agent.config.name, overrides: req.overrides })),
			[
				{ name: "reviewer", overrides: { model: "parent/reviewer", thinking: undefined } },
				{ name: "suffix", overrides: { model: "parent/reviewer:high", thinking: undefined } },
				{ name: "worker", overrides: { model: "parent/default", thinking: "medium" } },
				{ name: "task", overrides: { model: "parent/default", thinking: "medium" } },
				{ name: "reviewer", overrides: { model: "parent/special", thinking: "xhigh" } },
			],
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
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

test("agents.wait accepts timeoutMs as an alias for waitMs", async () => {
	const { provider } = harness(60_000);
	const handle = (await provider.invoke("start", { task: "do a thing" }, invocationContext())) as { runId: string };
	// The batch never settles; a 60s configured waitMs would otherwise mask a
	// timeoutMs of 0 not being honored.
	const waited = (await provider.invoke("wait", { runId: handle.runId, timeoutMs: 0 }, invocationContext())) as {
		state: string;
	};
	assert.equal(waited.state, "running");
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

test("a batch's timeout always comes from host configuration", async () => {
	const { provider, contextOf } = harness();
	await provider.invoke("run", { task: "do a thing", timeoutMs: 1 }, invocationContext());
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

test("every descriptor schema accepts supported native tool payloads", async () => {
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
	await accepts("run", { task: "t", waitMs: 1_000 });
	await accepts("run", { task: "t", reads: ["a.md"], night: true, model: "m", thinking: "high", output: "o.md" });
	await accepts("runAll", { tasks: [{ task: "t" }], waitMs: 1_000 });
	await accepts("start", { task: "t" });
	await accepts("start", { tasks: [{ task: "t" }] });
	await accepts("start", {});
	await accepts("wait", { runId: "r" });
	await accepts("wait", { runId: "r", waitMs: 0 });
	await accepts("wait", { runId: "r", timeoutMs: 5_000 });
	await accepts("status", {});
	await accepts("cancel", {});
	await accepts("cancel", { runId: "r" });

	// Timing is batch-level: a per-task window would be silently ignored.
	await rejects("runAll", { tasks: [{ task: "t", waitMs: 1 }] });
	await rejects("run", { task: "t", timeoutMs: 2_000 });
	await rejects("runAll", { tasks: [{ task: "t" }], timeoutMs: 2_000 });
	await rejects("start", { task: "t", timeoutMs: 2_000 });
	await rejects("run", { task: "t", unknown: 1 });
	await rejects("wait", {});
});

test("every subagent action declares an output schema for its actual result shapes", async () => {
	const { provider } = harness();
	const outputSchemaOf = async (action: string): Promise<Record<string, unknown>> => {
		const descriptor = await provider.describe(action, invocationContext());
		assert.ok(descriptor, `missing descriptor: ${action}`);
		assert.ok(descriptor.outputSchema, `missing output schema: ${action}`);
		return descriptor.outputSchema;
	};
	const accepts = async (action: string, result: unknown) => {
		const schema = await outputSchemaOf(action);
		assert.ok(Value.Check(schema, result), `${action} rejected ${JSON.stringify(result)}`);
	};
	const rejects = async (action: string, result: unknown) => {
		const schema = await outputSchemaOf(action);
		assert.ok(!Value.Check(schema, result), `${action} accepted ${JSON.stringify(result)}`);
	};

	const running = { agent: "task", ok: false, output: "still working", state: "running", runId: "r" };
	const settled = {
		agent: "task",
		ok: true,
		output: "done",
		state: "done",
		runId: "r",
		outputPath: "/tmp/result.md",
		exitCode: 0,
	};
	const failed = {
		agent: "task",
		ok: false,
		output: "failed",
		state: "failed",
		runId: "r",
		paneId: "w1:p1",
		error: "launch failed",
		failure: "launch",
	};
	const models = {
		defaultModel: null,
		models: [
			{ id: "provider/model", name: "Model", provider: "provider" },
			{
				id: "provider/vision",
				name: "Vision",
				provider: "provider",
				reasoning: true,
				input: ["text", "image"],
				contextWindow: 100_000,
				maxTokens: 8_000,
			},
		],
	};
	await accepts("models", models);
	await rejects("models", { defaultModel: null, models: [{ id: "x", name: "X", provider: "p", input: [1] }] });
	await accepts("list", [
		{ name: "reviewer", scope: "project" },
		{ name: "task", scope: "builtin", description: "Generic" },
	]);
	await accepts("run", running);
	await accepts("run", settled);
	await accepts("run", failed);
	await rejects("run", { ...running, ok: true });
	await accepts("runAll", [running, settled]);
	await accepts("start", { runId: "r", agents: ["task"], state: "running" });
	await accepts("wait", {
		runId: "r",
		state: "running",
		elapsedMs: 10,
		agents: ["task"],
		results: [running],
	});
	await accepts("wait", {
		runId: "r",
		state: "settled",
		elapsedMs: 20,
		agents: ["task"],
		results: [settled],
	});
	await accepts("wait", {
		runId: "r",
		state: "cancelled",
		elapsedMs: 20,
		agents: ["task"],
		results: [running],
	});
	await accepts("status", [
		{ runId: "r", agents: ["task"], state: "settled", startedAt: 1, elapsedMs: 2, detached: true },
	]);
	await accepts("cancel", { cancelled: ["r"] });
});

test("a launch failure reaches the sandbox as its own class, not as prose", async () => {
	const { provider, settle } = harness();
	const handle = (await provider.invoke("start", { task: "do a thing" }, invocationContext())) as { runId: string };
	settle([
		{
			agent: "task",
			scope: "user",
			ok: false,
			output: "(failed to run in herdr: timed out waiting for agent startup)",
			backend: "herdr",
			error: "timed out waiting for agent startup",
			failure: "launch",
		},
	]);
	const waited = (await provider.invoke("wait", { runId: handle.runId, waitMs: 1_000 }, invocationContext())) as {
		results: { state: string; failure?: string }[];
	};
	assert.equal(waited.results[0].state, "failed");
	// The coordinator has to be able to tell a broken runner from a bad task.
	assert.equal(waited.results[0].failure, "launch");
});

test("the breaker refuses to relaunch into a cause that already failed twice", async () => {
	let launches = 0;
	const headless: RunBackend = async (reqs) => {
		launches++;
		return reqs.map((req) => ({
			agent: req.agent.config.name,
			scope: "user",
			ok: false,
			output: "",
			backend: "headless" as const,
			error: `timed out waiting for agent startup (pane wA:p${launches})`,
			failure: "launch" as const,
		}));
	};
	const provider = new AgentsProvider(
		() => ({ sessionId: undefined, sessionFile: undefined, cwd: tmpdir() }),
		new AgentRunRegistry(),
		() => ({ timeoutMs: 60_000, waitMs: 1_000 }),
		new AgentRunBook({ announceDelayMs: 5 }),
		new RunLauncher({ inHerdr: () => false, headless }),
		new CauseBreaker({ limit: 2, retryAfterMs: 60_000, now: () => 1_000 }),
	);

	const run = async () =>
		(await provider.invoke("run", { task: "do a thing" }, invocationContext())) as Record<string, unknown>;

	await run();
	await run();
	assert.equal(launches, 2);

	// Third time the cause is known: no child is started at all.
	const refused = await run();
	assert.equal(launches, 2, "a proven cause is not paid for again");
	assert.equal(refused.state, "failed");
	assert.equal(refused.failure, "launch");
	assert.match(String(refused.error), /refusing to launch/);
	assert.match(String(refused.error), /waiting for agent startup/);
});

test("a run that reaches its child clears the breaker", async () => {
	let launches = 0;
	const headless: RunBackend = async (reqs) => {
		launches++;
		return reqs.map((req) =>
			launches === 1
				? {
						agent: req.agent.config.name,
						scope: "user",
						ok: false,
						output: "",
						backend: "headless" as const,
						error: "timed out waiting for agent startup",
						failure: "launch" as const,
					}
				: doneResult(req.agent.config.name),
		);
	};
	const breaker = new CauseBreaker({ limit: 2, retryAfterMs: 60_000, now: () => 1_000 });
	const provider = new AgentsProvider(
		() => ({ sessionId: undefined, sessionFile: undefined, cwd: tmpdir() }),
		new AgentRunRegistry(),
		() => ({ timeoutMs: 60_000, waitMs: 1_000 }),
		new AgentRunBook({ announceDelayMs: 5 }),
		new RunLauncher({ inHerdr: () => false, headless }),
		breaker,
	);
	const run = async () => await provider.invoke("run", { task: "do a thing" }, invocationContext());

	await run(); // launch failure
	await run(); // succeeded: the streak is broken
	await run();
	assert.equal(launches, 3);
	assert.equal(breaker.verdict(), undefined);
});

test("an active approved night rejects subagents without a checked todo id", () => {
	const run = {
		startedAt: Date.now(),
		reportPath: "/tmp/report.md",
		maxPullRequests: 2,
		approvedTaskIds: ["abcd1234"],
		sessionId: "coordinator",
	};
	const ref = { sessionId: "coordinator" };
	assert.throws(() => bindApprovedNightTasks([{ task: "unapproved work", night: true }], run, ref), /nightTodoId/);
	assert.throws(
		() => bindApprovedNightTasks([{ task: "wrong work", night: true, nightTodoId: "ffffffff" }], run, ref),
		/not approved/,
	);
});

test("an approved todo id is injected into the child task and forces the night contract", () => {
	const run = {
		startedAt: Date.now(),
		reportPath: "/tmp/report.md",
		maxPullRequests: 2,
		approvedTaskIds: ["abcd1234"],
		sessionId: "coordinator",
	};
	const [item] = bindApprovedNightTasks([{ task: "correct docs", nightTodoId: "TODO-abcd1234" }], run, {
		sessionId: "coordinator",
	});
	assert.equal(item.night, true);
	assert.equal(item.nightTodoId, "abcd1234");
	assert.match(item.task, /^Approved ledger item: TODO-abcd1234/);
});

test("an unrelated session is not constrained by another session's approved night", () => {
	const run = {
		startedAt: Date.now(),
		reportPath: "/tmp/report.md",
		maxPullRequests: 2,
		approvedTaskIds: ["abcd1234"],
		sessionId: "night-coordinator",
	};
	const items = [{ task: "normal interactive work" }];
	assert.deepEqual(bindApprovedNightTasks(items, run, { sessionId: "other", cwd: "/other/repo" }), items);
});
