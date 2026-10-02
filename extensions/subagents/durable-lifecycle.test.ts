import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import subagents from "./index.ts";
import { acquireDurableSupervisor, closeDurableSupervisor, durableDirectory } from "./durable-supervisor.ts";
import type { SessionRef } from "./agents-provider.ts";
import type { RunBackend, RunContext, RunRequest, RunResult } from "./run.ts";
import { buildChildArgs } from "./pi-args.ts";
import { testHost, withParentSession } from "./test-host.ts";

function backend(version: string) {
	const calls: Array<{ requests: RunRequest[]; context: RunContext; finish(): void }> = [];
	const run: RunBackend = (requests, context) =>
		new Promise((resolve) => {
			const results = (cancelled: boolean): RunResult[] =>
				requests.map((request) => ({
					agent: request.agent.config.name,
					scope: request.agent.scope,
					ok: !cancelled,
					output: cancelled ? "cancelled" : version,
					backend: "headless",
					...(cancelled ? { failure: "cancelled" as const, error: "cancelled" } : { exitCode: 0 }),
				}));
			context.signal?.addEventListener("abort", () => resolve(results(true)), { once: true });
			calls.push({ requests, context, finish: () => resolve(results(false)) });
		});
	return { run, calls };
}

function configuredHost(ref: SessionRef) {
	const host = testHost();
	const model = {
		id: "gpt-6.1-sol",
		provider: "openai",
		name: "Test model",
		api: "openai-completions",
		baseUrl: "https://invalid.example",
		reasoning: true,
		input: ["text"],
		contextWindow: 100_000,
		maxTokens: 1_000,
		cost: { input: 5, output: 25, cacheRead: 0, cacheWrite: 0 },
	};
	Object.assign(host.ctx, {
		cwd: ref.cwd,
		model,
		modelRegistry: {
			getAvailable: async () => [model, { ...model, provider: "anthropic", id: "claude-opus-5-5" }],
		},
		sessionManager: {
			getSessionId: () => ref.sessionId,
			getSessionFile: () => ref.sessionFile,
		},
	});
	host.setIdle(false);
	return host;
}

test("durable reload reconnects run handles and replaces only the runner generation", async () => {
	await withParentSession(async () => {
		const root = process.env.PI_CODING_AGENT_DIR!;
		writeFileSync(join(root, "subagents.json"), JSON.stringify({ backend: "durable" }));
		const ref: SessionRef = { cwd: root, sessionId: "parent", sessionFile: join(root, "parent.jsonl") };
		const v1 = backend("v1");
		const v2 = backend("v2");
		const first = configuredHost(ref);
		subagents(first.api, { acquireDurableSupervisor: (session) => acquireDurableSupervisor(session, v1.run) });
		try {
			await first.emit("session_start", { reason: "startup" });
			const started = (await first.execute("agents_start", { task: "review" })).structuredContent as {
				runId: string;
			};
			assert.equal(v1.calls.length, 1);
			await first.emit("session_shutdown", { reason: "reload" });
			assert.equal(v1.calls[0]?.context.signal?.aborted, false);
			assert.ok([...first.tools.values()].every((tool) => tool.exposure === "hidden"));

			const second = configuredHost(ref);
			subagents(second.api, { acquireDurableSupervisor: (session) => acquireDurableSupervisor(session, v2.run) });
			await second.emit("session_start", { reason: "reload" });
			const status = (await second.execute("agents_status", {})).structuredContent as Array<{ runId: string }>;
			assert.equal(status[0]?.runId, started.runId);
			const waiting = second.execute("agents_wait", { runId: started.runId, waitMs: 1_000 });
			v1.calls[0]!.finish();
			const outcome = (await waiting).structuredContent as { results: Array<{ output: string }> };
			assert.equal(outcome.results[0]?.output, "v1");
			assert.equal(first.sent.length, 0);
			assert.equal(second.sent.length, 0);

			await second.execute("agents_start", { task: "another review" });
			assert.equal(v2.calls.length, 1);
			await second.emit("session_shutdown", { reason: "quit" });
			assert.equal(v2.calls[0]?.context.signal?.aborted, true);
		} finally {
			await closeDurableSupervisor(ref);
		}
	});
});

test("durable runs keep agent sandbox, context inheritance and project trust policy", async () => {
	await withParentSession(async () => {
		const root = process.env.PI_CODING_AGENT_DIR!;
		writeFileSync(join(root, "subagents.json"), JSON.stringify({ backend: "durable" }));
		mkdirSync(join(root, "agents"));
		writeFileSync(
			join(root, "agents", "reader.md"),
			"---\nname: reader\nsandbox: read-only\ninheritSkills: false\ninheritProjectContext: false\ndefaultReads: README.md\n---\nOnly inspect files.",
		);
		const ref: SessionRef = { cwd: root, sessionId: "policy", sessionFile: join(root, "policy.jsonl") };
		const fake = backend("reviewed");
		const host = configuredHost(ref);
		subagents(host.api, { acquireDurableSupervisor: (session) => acquireDurableSupervisor(session, fake.run) });
		try {
			await host.emit("session_start", { reason: "startup" });
			await host.execute("agents_start", { agent: "reader", task: "inspect" });
			await assert.rejects(
				host.execute("agents_start", { task: "inspect", model: "anthropic/claude-opus-5-5" }),
				/caller.s provider/,
			);
			assert.equal(fake.calls.length, 1);
			const call = fake.calls[0]!;
			assert.equal(call.requests[0]?.overrides?.model, "openai/gpt-6.1-sol");
			assert.equal(call.context.projectTrusted, false);
			assert.deepEqual(call.requests[0]?.reads, ["README.md"]);
			const request = call.requests[0]!;
			const args = buildChildArgs(request.agent, request.task, {
				sessionFile: "child.jsonl",
				projectTrusted: call.context.projectTrusted,
			});
			assert.ok(args.includes("--no-approve"));
			assert.ok(args.includes("--no-skills"));
			assert.ok(args.includes("--no-context-files"));
			assert.ok(args.includes("read-only"));
			await host.emit("session_shutdown", { reason: "new" });
			assert.equal(call.context.signal?.aborted, true);
		} finally {
			await closeDurableSupervisor(ref);
		}
	});
});

test("durable identities are file-backed and never share results across parents or working directories", () => {
	const ref: SessionRef = { cwd: "/repo", sessionId: "one", sessionFile: "/sessions/parent.jsonl" };
	assert.throws(() => durableDirectory({ ...ref, sessionFile: undefined }), /file-backed/);
	assert.notEqual(durableDirectory(ref), durableDirectory({ ...ref, sessionId: "two" }));
	assert.notEqual(durableDirectory(ref), durableDirectory({ ...ref, cwd: "/other" }));
});

test("opting out during reload closes the retained durable supervisor", async () => {
	await withParentSession(async () => {
		const root = process.env.PI_CODING_AGENT_DIR!;
		const config = join(root, "subagents.json");
		writeFileSync(config, JSON.stringify({ backend: "durable" }));
		const ref: SessionRef = { cwd: root, sessionId: "opt-out", sessionFile: join(root, "opt-out.jsonl") };
		const fake = backend("old");
		const old = configuredHost(ref);
		subagents(old.api, { acquireDurableSupervisor: (session) => acquireDurableSupervisor(session, fake.run) });
		try {
			await old.emit("session_start", { reason: "startup" });
			await old.execute("agents_start", { task: "review" });
			await old.emit("session_shutdown", { reason: "reload" });
			writeFileSync(config, "{}");
			const next = configuredHost(ref);
			subagents(next.api);
			await next.emit("session_start", { reason: "reload" });
			assert.equal(fake.calls[0]?.context.signal?.aborted, true);
			assert.deepEqual((await next.execute("agents_status", {})).structuredContent, []);
			await next.emit("session_shutdown", { reason: "quit" });
		} finally {
			await closeDurableSupervisor(ref);
		}
	});
});

test("concurrent acquisition shares ownership and acquisition during close waits for release", async () => {
	await withParentSession(async () => {
		const root = process.env.PI_CODING_AGENT_DIR!;
		const ref: SessionRef = { cwd: root, sessionId: "concurrent", sessionFile: join(root, "concurrent.jsonl") };
		const fake = backend("unused");
		const [first, second] = await Promise.all([
			acquireDurableSupervisor(ref, fake.run),
			acquireDurableSupervisor(ref, fake.run),
		]);
		assert.equal(first, second);
		let finish!: () => void;
		let cancelled!: () => void;
		const abort = new Promise<void>((resolve) => {
			cancelled = resolve;
		});
		await first.book.register({
			runId: "closing",
			agents: ["task"],
			promise: new Promise((resolve) => {
				finish = () => resolve([]);
			}),
			cancel: cancelled,
		});
		const closing = closeDurableSupervisor(ref);
		const acquired = acquireDurableSupervisor(ref, fake.run);
		try {
			await abort;
			finish();
			await closing;
			const replacement = await acquired;
			assert.notEqual(replacement, first);
			assert.equal(replacement.book.list()[0]?.state, "cancelled");
		} finally {
			finish();
			await closing;
			await acquired;
			await closeDurableSupervisor(ref);
		}
	});
});
