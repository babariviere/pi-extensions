import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { access, cp, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import {
	defineExtension,
	defineTool,
	MemoryStorage,
	type Extension,
	type Harness,
	type Storage,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { ConversationRuntime } from "./conversation-runtime.ts";
import {
	installConversationWorker,
	type WorkerAdapter,
	type WorkerHost,
	type WorkerPacket,
} from "./conversation-worker.ts";
import { builtinAgent } from "./discovery.ts";
import { openDurableStorage } from "./durable-storage.ts";
import type { RunContext, RunRequest } from "./run.ts";

const ctx = BACKGROUND_CONTEXT;
const model = { provider: "faux", modelId: "faux-1" };
function setup(extension: Extension = defineExtension({ name: "test-native" })) {
	const models = createModels();
	const faux = fauxProvider();
	models.setProvider(faux.provider);
	return { faux, options: { models, extension, model, cwd: process.cwd() } };
}
async function until(check: () => boolean | Promise<boolean>) {
	for (let n = 0; n < 500; n++) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail("Timed out waiting for durable progress");
}
function interrupted(signal: AbortSignal | undefined): Promise<never> {
	return new Promise((_resolve, reject) => {
		if (signal?.aborted) reject(signal.reason);
		else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
	});
}
const entries = async (runtime: ConversationRuntime, root = false) =>
	(await (root ? runtime.root : runtime.child).entries({}, 100, undefined, ctx)).items;

test("deduplicates concurrent admission, passively reports once, and keeps child history", async () => {
	const { faux, options } = setup();
	faux.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer")]);
	const runtime = await ConversationRuntime.open(new MemoryStorage(), options);
	try {
		const [first, duplicate] = await Promise.all([
			runtime.run("__proto__", "first"),
			runtime.run("__proto__", "first"),
		]);
		assert.deepEqual(first, duplicate);
		assert.equal(first.answer?.text, "first answer");
		assert.equal(first.ok, true);
		const next = await runtime.run("second", "second");
		assert.equal((await runtime.status()).conversationId, String(runtime.conversationId));
		assert.equal(next.answer?.text, "second answer");
		await assert.rejects(runtime.run("second", "changed"), /different content/);
		assert.equal(faux.state.callCount, 2, "only child generation, no root model calls");
		assert.equal((await entries(runtime)).filter((entry) => entry.kind === "pi.user").length, 2);
		const reports = await entries(runtime, true);
		assert.equal(reports.length, 2);
		assert.ok(reports.every((entry) => entry.kind === "subagents.report" && !entry.model));
		const graph = await runtime.harness.taskGraph(ctx);
		graph.dispose();
		await runtime.root.waitForIdle(ctx);
	} finally {
		await runtime.close();
	}
});

test("provider diagnostics survive Reporter delivery and SQLite reopen without another model call", async () => {
	const directory = await mkdtemp(join(tmpdir(), "conversation-provider-error-"));
	const file = join(directory, "session.sqlite");
	const { faux, options } = setup();
	const error = "Codex error: Request was rejected by the provider.";
	faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: error })]);
	let runtime = await ConversationRuntime.open(await openNodeSqliteStorage(file), options);
	try {
		const result = await runtime.run("provider-error", "work");
		assert.deepEqual(result, { ok: false, error });
		assert.deepEqual((await entries(runtime, true))[0]?.data, { requestId: "provider-error", ...result });
		assert.equal((await runtime.status()).lastAnswer, undefined);
		await runtime.close();
		runtime = await ConversationRuntime.open(await openNodeSqliteStorage(file), options);
		assert.deepEqual(await runtime.run("provider-error", "work"), result);
		assert.equal(faux.state.callCount, 1);
		assert.equal((await entries(runtime, true)).length, 1);
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("settled failures use textual diagnostics, safely fall back, and preserve abort semantics", async () => {
	const { faux, options } = setup();
	const runtime = await ConversationRuntime.open(new MemoryStorage(), options);
	const overload = "Codex error: Our servers are currently overloaded. Please try again later.";
	const cases = [
		{ reason: "model_error", detail: overload, expected: { ok: false, error: overload } },
		{ reason: "model_error", expected: { ok: false, error: "model_error" } },
		{ reason: "model_error", detail: "  \n", expected: { ok: false, error: "model_error" } },
		{
			reason: "model_error",
			detail: { privateDiagnostic: "not for publication" },
			expected: { ok: false, error: "model_error" },
		},
		{ reason: "model_error", detail: 42, expected: { ok: false, error: "model_error" } },
		{ reason: "aborted", detail: overload, expected: { ok: false, aborted: true } },
	];
	try {
		for (const [index, { reason, detail, expected }] of cases.entries()) {
			const requestId = `settled-${index}`;
			await runtime.child.commit(
				(tx) =>
					tx.createSubmission({
						conversationId: runtime.conversationId,
						requestId,
						type: "input",
						status: "unanswered",
						reason,
						...(detail === undefined ? {} : { detail }),
					}),
				ctx,
			);
			assert.deepEqual(await runtime.run(requestId, "work"), expected);
		}
		assert.equal(faux.state.callCount, 0, "settled failures never regenerate");
	} finally {
		await runtime.close();
	}
});

test("SQLite reopen resumes an unfinished model request, retaining child and Reporter identity", async () => {
	const directory = await mkdtemp(join(tmpdir(), "conversation-reopen-"));
	const file = join(directory, "session.sqlite");
	const { faux, options } = setup();
	faux.setResponses([async (_request, stream) => interrupted(stream?.signal), fauxAssistantMessage("resumed answer")]);
	let runtime = await ConversationRuntime.open(await openNodeSqliteStorage(file), options);
	try {
		const id = runtime.conversationId;
		const pending = runtime.run("stable-input", "finish this").catch(() => undefined);
		await until(() => faux.state.callCount === 1);
		const graph = await runtime.harness.taskGraph(ctx);
		const reporterId = Object.values(graph.value.tasks).find(
			(task) => task.kind === "subagents.conversation-reporter",
		)!.id;
		graph.dispose();
		await runtime.root.abort(ctx);
		assert.equal(faux.state.callCount, 1, "root Esc leaves background child alone");
		await runtime.close();
		await pending;
		runtime = await ConversationRuntime.open(await openNodeSqliteStorage(file), options);
		assert.equal(runtime.conversationId, id);
		assert.equal(faux.state.callCount, 1, "open does not race native binding");
		runtime.resume();
		const result = await runtime.run("stable-input", "finish this");
		assert.equal(result.answer?.text, "resumed answer");
		assert.equal(result.ok, true);
		assert.equal((await runtime.harness.getTask(reporterId, ctx))?.state.status, "terminal");
		assert.equal((await entries(runtime)).filter((entry) => entry.kind === "pi.user").length, 1);
		assert.equal((await entries(runtime, true)).length, 1);
		await runtime.close();
		runtime = await ConversationRuntime.open(await openNodeSqliteStorage(file), options);
		assert.deepEqual(await runtime.run("stable-input", "finish this"), result);
		assert.equal(faux.state.callCount, 2);
		assert.equal((await entries(runtime, true)).length, 1);
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("an interrupted arbitrary native tool becomes an error result, never a replay", async () => {
	const directory = await mkdtemp(join(tmpdir(), "conversation-tool-"));
	const file = join(directory, "session.sqlite");
	let executions = 0;
	const tool = defineTool({
		name: "native_effect",
		description: "Irreversible native effect",
		parameters: Type.Object({}),
		replay: "safe", // Runtime must override even an accidentally safe bridge declaration.
		execute: async (_args, _api, callContext) => {
			executions++;
			return interrupted(callContext.abortSignal);
		},
	});
	const { faux, options } = setup(defineExtension({ name: "test-native", tools: [tool] }));
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("native_effect", {})], { stopReason: "toolUse" }),
		(request) => {
			const result = [...request.messages].reverse().find((message) => message.role === "toolResult");
			assert.equal(result?.role, "toolResult");
			assert.equal(result.isError, true);
			assert.match(JSON.stringify(result.content), /interrupt/i);
			return fauxAssistantMessage("Tool interrupted, checked without replay.");
		},
	]);
	let runtime = await ConversationRuntime.open(await openNodeSqliteStorage(file), options);
	try {
		const pending = runtime.run("effect", "do work").catch(() => undefined);
		await until(() => executions === 1);
		await runtime.close();
		await pending;
		runtime = await ConversationRuntime.open(await openNodeSqliteStorage(file), options);
		const result = await runtime.run("effect", "do work");
		assert.equal(result.ok, true);
		assert.equal(executions, 1);
		assert.equal(faux.state.callCount, 2);
		assert.equal((await entries(runtime)).filter((entry) => entry.kind === "pi.tool-result").length, 1);
		assert.equal((await entries(runtime, true)).length, 1);
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("explicit cancel aborts reporter and child, and cancelled work cannot resume", async () => {
	const directory = await mkdtemp(join(tmpdir(), "conversation-cancel-"));
	const file = join(directory, "session.sqlite");
	const { faux, options } = setup();
	faux.setResponses([async (_request, stream) => interrupted(stream?.signal)]);
	let runtime = await ConversationRuntime.open(await openNodeSqliteStorage(file), options);
	try {
		const pending = runtime.run("cancel", "working");
		await until(() => faux.state.callCount === 1);
		await runtime.cancel();
		assert.equal((await pending).ok, false);
		assert.equal((await runtime.harness.inspect(ctx)).tasks.length, 0);
		await runtime.close();
		runtime = await ConversationRuntime.open(await openNodeSqliteStorage(file), options);
		assert.equal((await runtime.run("cancel", "working")).ok, false);
		assert.equal(faux.state.callCount, 1);
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("reopen between deliver and report resumes checkpoint without another generation", async () => {
	const directory = await mkdtemp(join(tmpdir(), "conversation-report-"));
	const file = join(directory, "session.sqlite");
	const { faux, options } = setup();
	faux.setResponses([fauxAssistantMessage("checkpointed answer")]);
	const storage = await openNodeSqliteStorage(file);
	let runtime: ConversationRuntime;
	let closing: Promise<void> | undefined;
	const observed = new Proxy(storage, {
		get(target, property) {
			if (property === "commit")
				return async (...args: Parameters<Storage["commit"]>) => {
					const seq = await target.commit(...args);
					if (
						args[0].some(
							(write) =>
								write.type === "task" &&
								write.value.kind === "subagents.conversation-reporter" &&
								write.value.state.status === "running" &&
								(write.value.state.checkpoint as { phase?: string }).phase === "report",
						)
					) {
						queueMicrotask(() => {
							closing = runtime.close();
						});
					}
					return seq;
				};
			const value = Reflect.get(target, property);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	runtime = await ConversationRuntime.open(observed, options);
	try {
		const pending = runtime.run("checkpoint", "answer this").catch(() => undefined);
		await until(() => closing !== undefined);
		await closing;
		await pending;
		runtime = await ConversationRuntime.open(await openNodeSqliteStorage(file), options);
		assert.equal((await entries(runtime, true)).length, 0, "report was not yet written");
		const result = await runtime.run("checkpoint", "answer this");
		assert.equal(result.answer?.text, "checkpointed answer");
		assert.equal(faux.state.callCount, 1);
		assert.equal((await entries(runtime, true)).length, 1);
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("stable admission, queued stop and stop-then-send preserve a reusable child", async () => {
	const { faux, options } = setup();
	faux.setResponses([async (_r, stream) => interrupted(stream?.signal), fauxAssistantMessage("after stop")]);
	const runtime = await ConversationRuntime.open(new MemoryStorage(), options);
	try {
		const first = await runtime.admit("active", "active");
		assert.strictEqual(await runtime.admit("active", "active"), first);
		await assert.rejects(runtime.admit("active", "active", true), /different content or mode/);
		await until(() => faux.state.callCount === 1);
		const queued = await runtime.admit("queued", "queued", true);
		assert.equal((await runtime.status()).working, true);
		await runtime.stop();
		assert.deepEqual(await first.wait(), { ok: false, aborted: true });
		assert.deepEqual(await queued.wait(), { ok: false, aborted: true });
		assert.equal((await runtime.status()).working, false);
		assert.equal((await entries(runtime, true)).length, 0);
		assert.equal((await runtime.harness.inspect(ctx)).submissions.length, 0);
		assert.deepEqual(await runtime.run("queued", "queued", true), { ok: false, aborted: true });
		const result = await runtime.run("next", "next");
		assert.equal(result.answer?.text, "after stop");
		assert.deepEqual((await runtime.status()).lastAnswer, result.answer);
		assert.equal(faux.state.callCount, 2);
	} finally {
		await runtime.close();
	}
});

test("immediate admit then stop cannot leave a Reporter that redelivers", async () => {
	const { faux, options } = setup();
	faux.setResponses([async (_r, stream) => interrupted(stream?.signal)]);
	const runtime = await ConversationRuntime.open(new MemoryStorage(), options);
	try {
		const admission = runtime.admit("race", "race");
		const stopped = runtime.stop();
		const handle = await admission;
		await stopped;
		assert.deepEqual(await handle.wait(), { ok: false, aborted: true });
		assert.equal((await runtime.status()).working, false);
		faux.setResponses([fauxAssistantMessage("new")]);
		assert.equal((await runtime.run("new", "new")).answer?.text, "new");
		assert.equal((await entries(runtime)).filter((e) => e.kind === "pi.user").length, 2);
	} finally {
		await runtime.close();
	}
});

test("repeated multi-message history and pinned model survive SQLite reopen", async () => {
	const directory = await mkdtemp(join(tmpdir(), "persistent-history-"));
	const file = join(directory, "session.sqlite");
	const { faux, options } = setup();
	faux.setResponses(
		Array.from({ length: 4 }, (_, n) => (request) => {
			const history = JSON.stringify(request.messages);
			for (let previous = 0; previous < n; previous++) {
				assert.match(history, new RegExp("message-" + previous));
				assert.match(history, new RegExp("answer-" + previous));
			}
			return fauxAssistantMessage("answer-" + n);
		}),
	);
	let runtime = await ConversationRuntime.open(await openNodeSqliteStorage(file), options);
	try {
		const child = runtime.conversationId;
		for (let n = 0; n < 4; n++) {
			if (n === 2) {
				await runtime.close();
				runtime = await ConversationRuntime.open(await openNodeSqliteStorage(file), {
					...options,
					model: { provider: "faux", modelId: "faux-2" },
				});
				assert.equal(runtime.conversationId, child);
				assert.deepEqual((await runtime.child.agent(ctx)).model, model);
			}
			const answer = await runtime.run("id-" + n, "message-" + n);
			assert.equal(answer.answer?.text, "answer-" + n);
			assert.deepEqual((await runtime.status()).lastAnswer, answer.answer);
		}
		assert.equal(faux.state.callCount, 4);
		assert.equal((await entries(runtime, true)).length, 4);
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("steering coalesces to one answer report; follow-up starts a separate run", async () => {
	let release!: () => void;
	let started = false;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const tool = defineTool({
		name: "gate",
		description: "gate",
		parameters: Type.Object({}),
		execute: async () => {
			started = true;
			await gate;
			return { content: [{ type: "text", text: "done" }] };
		},
	});
	const { faux, options } = setup(defineExtension({ name: "test-native", tools: [tool] }));
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("gate", {})], { stopReason: "toolUse" }),
		(request) => {
			assert.match(JSON.stringify(request.messages), /steering/);
			assert.doesNotMatch(JSON.stringify(request.messages), /follow-message/);
			return fauxAssistantMessage("shared answer");
		},
		(request) => {
			assert.match(JSON.stringify(request.messages), /follow-message/);
			return fauxAssistantMessage("follow answer");
		},
	]);
	const runtime = await ConversationRuntime.open(new MemoryStorage(), options);
	try {
		const initial = await runtime.admit("initial", "initial");
		await until(() => started);
		const steering = await runtime.admit("steering", "steering", false);
		const follow = await runtime.admit("follow", "follow-message", true);
		release();
		const first = await initial.wait();
		assert.deepEqual(await steering.wait(), first);
		assert.equal(first.answer?.text, "shared answer");
		assert.equal((await follow.wait()).answer?.text, "follow answer");
		assert.equal((await entries(runtime, true)).length, 2);
	} finally {
		release();
		await runtime.close();
	}
});

function workerHost() {
	const events = new EventEmitter();
	const packets: WorkerPacket[] = [];
	let code: number | undefined;
	const host: WorkerHost = {
		on: (event, listener) => {
			events.on(event, listener);
		},
		off: (event, listener) => {
			events.off(event, listener);
		},
		send: async (packet) => {
			packets.push(packet);
		},
		exit: (value) => {
			code = value;
		},
	};
	return {
		host,
		events,
		packets,
		get code() {
			return code;
		},
	};
}
function launchFor(directory: string) {
	const request: RunRequest = {
		agent: builtinAgent(),
		task: "MUST NOT BE IMPLICITLY SUBMITTED",
		index: 0,
	};
	const context: RunContext = {
		cwd: directory,
		sessionFile: join(directory, "parent.jsonl"),
		sessionId: "parent",
		runId: "worker-test",
		timeoutMs: 60_000,
	};
	return { type: "start" as const, spec: { name: "helper", request, context, directory: join(directory, "private") } };
}
const input = (id: string, message = id, followUp = false) => ({ type: "input" as const, id, message, followUp });
const answers = (host: ReturnType<typeof workerHost>) =>
	host.packets.filter((packet): packet is Extract<WorkerPacket, { type: "answer" }> => packet.type === "answer");
async function pause(host: ReturnType<typeof workerHost>) {
	if (host.code === undefined) host.events.emit("message", { type: "pause" });
	await until(() => host.code !== undefined);
}

test("persistent worker acknowledges admissions before answers and stays alive across stop/status/send", async () => {
	const directory = await mkdtemp(join(tmpdir(), "persistent-worker-"));
	const { faux, options } = setup();
	const host = workerHost();
	let bound: Harness | undefined;
	let closed = false;
	let expansions = 0;
	const adapter: WorkerAdapter = {
		...options,
		bindHarness: (harness) => {
			bound = harness;
		},
		prepareInput: async (content) => {
			assert.equal(content, expansions === 0 ? "active" : "next");
			assert.doesNotMatch(content, /Task:|complete findings|Output:/);
			expansions++;
			return content;
		},
		close: async () => {
			await assert.rejects(bound!.inspect(ctx), /closed/);
			closed = true;
		},
	};
	faux.setResponses([
		async (_r, stream) => {
			assert.ok(bound);
			return interrupted(stream?.signal);
		},
		fauxAssistantMessage("second answer"),
	]);
	installConversationWorker(host.host, { openStorage: openDurableStorage, openAdapter: async () => adapter });
	try {
		host.events.emit("message", launchFor(directory));
		await until(() => host.packets.some((p) => p.type === "ready"));
		assert.equal(faux.state.callCount, 0);
		const ready = host.packets[0]!;
		if (ready.type !== "ready") assert.fail();
		assert.equal(typeof ready.status.conversationId, "string");
		host.events.emit("message", input("one", "active"));
		await until(() => host.packets.some((p) => p.type === "accepted"));
		assert.equal(answers(host).length, 0);
		host.events.emit("message", { type: "status", id: "busy" });
		await until(() => host.packets.some((p) => p.type === "status"));
		host.events.emit("message", { type: "stop", id: "stop" });
		await until(() => host.packets.some((p) => p.type === "stopped"));
		await until(() => answers(host).length === 1);
		assert.deepEqual(answers(host)[0]!.result, { ok: false, aborted: true });
		const stopped = host.packets.find((p) => p.type === "stopped")!;
		if (stopped.type !== "stopped") assert.fail();
		assert.equal(stopped.status.working, false);
		assert.equal(host.code, undefined);
		host.events.emit("message", input("two", "next"));
		await until(() => answers(host).length === 2);
		assert.equal(answers(host)[1]!.result.answer?.text, "second answer");
		assert.equal(answers(host)[1]!.status.conversationId, ready.status.conversationId);
		assert.deepEqual(answers(host)[1]!.status.lastAnswer, answers(host)[1]!.result.answer);
		host.events.emit("message", input("two", "next"));
		await until(() => host.packets.filter((p) => p.type === "accepted").length === 3);
		assert.equal(expansions, 2);
		assert.equal(answers(host).length, 2);
		assert.deepEqual(await readdir(directory), ["private"]);
		assert.equal(host.code, undefined);
		await pause(host);
		assert.equal(host.code, 0);
		assert.equal(closed, true);
	} finally {
		await pause(host);
		await rm(directory, { recursive: true, force: true });
	}
});

for (const stop of ["pause", "cancel", "disconnect", "SIGTERM"] as const) {
	test(`worker ${stop} closes and ${stop === "cancel" ? "aborts" : "preserves"} durable pending work`, async () => {
		const directory = await mkdtemp(join(tmpdir(), "persistent-worker-close-"));
		const { faux, options } = setup();
		faux.setResponses([
			async (_r, stream) => interrupted(stream?.signal),
			fauxAssistantMessage("recovered worker"),
			fauxAssistantMessage("queued recovery"),
		]);
		const host = workerHost();
		const command = launchFor(directory);
		let nativeClosed = false;
		installConversationWorker(host.host, {
			openStorage: openDurableStorage,
			openAdapter: async () => ({
				...options,
				bindHarness() {},
				close: async () => {
					nativeClosed = true;
				},
			}),
		});
		try {
			host.events.emit("message", command);
			await until(() => host.packets.some((p) => p.type === "ready"));
			host.events.emit("message", input("pending", "working"));
			host.events.emit("message", input("queued", "queued", true));
			await until(() => host.packets.filter((p) => p.type === "accepted").length === 2);
			await until(() => faux.state.callCount === 1);
			if (stop === "pause" || stop === "cancel") host.events.emit("message", { type: stop });
			else host.events.emit(stop);
			await until(() => host.code !== undefined);
			assert.equal(host.code, 0);
			assert.equal(nativeClosed, true);
			assert.equal(answers(host).length, 0);
			assert.equal(
				host.packets.some((p) => p.type === "error"),
				false,
			);
			assert.equal(
				host.packets.some((p) => p.type === "paused"),
				stop === "pause" || stop === "SIGTERM",
			);
			const owned = await openDurableStorage(command.spec.directory);
			const runtime = await ConversationRuntime.open(owned.storage, options);
			try {
				const result = await runtime.run("pending", "working");
				assert.equal(result.ok, stop !== "cancel");
				const queued = await runtime.run("queued", "queued", true);
				assert.equal(queued.ok, stop !== "cancel");
				if (stop === "cancel") assert.deepEqual(result, { ok: false, aborted: true });
				assert.equal((await runtime.status()).working, false);
				assert.equal(
					(await entries(runtime)).filter((e) => e.kind === "pi.user").length,
					stop === "cancel" ? 1 : 2,
				);
			} finally {
				await runtime.close();
				owned.release();
			}
		} finally {
			await pause(host);
			await rm(directory, { recursive: true, force: true });
		}
	});
}

test("worker owner handoff excludes concurrent native kernels", async () => {
	const directory = await mkdtemp(join(tmpdir(), "persistent-worker-owner-"));
	const { options } = setup();
	const command = launchFor(directory);
	const owned = await openDurableStorage(command.spec.directory);
	const host = workerHost();
	let kernels = 0;
	installConversationWorker(host.host, {
		openStorage: openDurableStorage,
		openAdapter: async () => {
			kernels++;
			return { ...options, bindHarness() {}, close: async () => {} };
		},
	});
	try {
		host.events.emit("message", command);
		await new Promise((resolve) => setTimeout(resolve, 75));
		assert.equal(kernels, 0);
		await owned.storage.close(ctx);
		owned.release();
		await until(() => host.packets.some((p) => p.type === "ready"));
		assert.equal(kernels, 1);
		assert.equal(host.code, undefined);
	} finally {
		owned.release();
		await pause(host);
		await rm(directory, { recursive: true, force: true });
	}
});

test("pause recovery observes Reporters and reuses persisted native input expansion", async () => {
	const directory = await mkdtemp(join(tmpdir(), "persistent-worker-expansion-"));
	const { faux, options } = setup();
	faux.setResponses([
		async (_r, stream) => interrupted(stream?.signal),
		(request) => {
			assert.match(JSON.stringify(request.messages), /1:original/);
			return fauxAssistantMessage("recovered");
		},
	]);
	let expansions = 0;
	const deps = {
		openStorage: openDurableStorage,
		openAdapter: async (request: RunRequest): Promise<WorkerAdapter> => {
			if (expansions > 0) assert.equal(request.overrides?.model, "faux/faux-1", "kernel reopens with pinned model");
			return {
				...options,
				bindHarness() {},
				close: async () => {},
				prepareInput: async (content) => `${++expansions}:${content}`,
			};
		},
	};
	const hosts = [workerHost(), workerHost(), workerHost()];
	const command = launchFor(directory);
	try {
		const [first, second, third] = hosts as [
			ReturnType<typeof workerHost>,
			ReturnType<typeof workerHost>,
			ReturnType<typeof workerHost>,
		];
		installConversationWorker(first.host, deps);
		first.events.emit("message", command);
		first.events.emit("message", input("stable", "original"));
		await until(() => faux.state.callCount === 1);
		await pause(first);
		installConversationWorker(second.host, deps);
		second.events.emit("message", command);
		second.events.emit("message", input("stable", "original"));
		await until(() => answers(second).length === 1);
		assert.equal(answers(second)[0]!.result.ok, true);
		assert.equal(expansions, 1);
		assert.equal(faux.state.callCount, 2);
		await pause(second);
		installConversationWorker(third.host, deps);
		third.events.emit("message", command);
		await until(() => answers(third).length === 1);
		assert.deepEqual(answers(third)[0]!.result, answers(second)[0]!.result);
		assert.equal(faux.state.callCount, 2);
	} finally {
		for (const host of hosts) await pause(host);
		await rm(directory, { recursive: true, force: true });
	}
});

test("native tools remain sequential even with parallel annotations and dynamic replacement", async () => {
	let release!: () => void;
	let started = 0;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const tool = defineTool({
		name: "effect",
		description: "effect",
		parameters: Type.Object({}),
		replay: "safe",
		executionMode: "parallel",
		execute: async () => {
			started++;
			if (started === 1) await gate;
			return { content: [{ type: "text", text: "done" }] };
		},
	});
	const { faux, options } = setup();
	const runtime = await ConversationRuntime.open(new MemoryStorage(), options);
	runtime.installExtension(defineExtension({ name: "test-native", tools: [tool] }));
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("effect", {}), fauxToolCall("effect", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	try {
		assert.ok(
			(await runtime.child.agent(ctx)).tools.every((t) => t.replay === "unsafe" && t.executionMode === "sequential"),
		);
		const pending = runtime.run("sequential", "work");
		await until(() => started === 1);
		await new Promise((resolve) => setTimeout(resolve, 25));
		assert.equal(started, 1, "second call cannot overlap native state");
		release();
		assert.equal((await pending).ok, true);
		assert.equal(started, 2);
	} finally {
		release();
		await runtime.close();
	}
});

test("host night framing excludes the output rider and requires a host workspace for artifacts", async () => {
	const directory = await mkdtemp(join(tmpdir(), "persistent-night-"));
	const { faux, options } = setup();
	faux.setResponses([fauxAssistantMessage("night answer"), fauxAssistantMessage("next night answer")]);
	const command = launchFor(directory);
	command.spec.request.night = true;
	command.spec.request.artifactsDir = join(directory, "artifacts");
	command.spec.context.nightRun = {
		startedAt: Date.now(),
		reportPath: join(directory, "night-report.md"),
		maxPullRequests: 2,
	};
	let prepared = "";
	const deps = {
		openStorage: openDurableStorage,
		openAdapter: async () => ({
			...options,
			bindHarness() {},
			close: async () => {},
			prepareInput: async (content: string) => {
				prepared = content;
				return content;
			},
		}),
	};
	const first = workerHost();
	const second = workerHost();
	try {
		installConversationWorker(first.host, deps);
		first.events.emit("message", command);
		first.events.emit("message", input("night", "do night work"));
		await until(() => answers(first).length === 1);
		assert.match(prepared, /\[night-mode\]/);
		assert.match(prepared, /Never ask a question/);
		assert.match(prepared, /do night work/);
		assert.doesNotMatch(prepared, /Approved ledger scope/);
		assert.doesNotMatch(prepared, /Deliverables directory|Output:|Task:|complete findings/);
		await pause(first);
		command.spec.request.cwd = directory;
		installConversationWorker(second.host, deps);
		second.events.emit("message", command);
		second.events.emit("message", input("night-next", "next"));
		await until(() => answers(second).some((p) => p.id === "night-next"));
		assert.match(prepared, /Deliverables directory/);
		assert.match(prepared, /your own workspace/);
	} finally {
		await pause(first);
		await pause(second);
		await rm(directory, { recursive: true, force: true });
	}
});

test("missing active host night contract fails closed before kernel startup", async () => {
	const { options } = setup();
	const host = workerHost();
	const command = launchFor(process.cwd());
	command.spec.request.night = true;
	let opened = 0;
	installConversationWorker(host.host, {
		openStorage: async () => ({ storage: new MemoryStorage(), release() {} }),
		openAdapter: async () => {
			opened++;
			return { ...options, bindHarness() {}, close: async () => {} };
		},
	});
	host.events.emit("message", command);
	await until(() => host.code !== undefined);
	assert.equal(host.code, 1);
	assert.equal(opened, 0);
	assert.equal(host.packets[0]?.type, "error");
});

test("real process IPC supports repeated input/status/stop without a one-shot exit", async () => {
	const directory = await mkdtemp(join(tmpdir(), "persistent-ipc-"));
	const workerUrl = new URL("./conversation-worker.ts", import.meta.url).href;
	// Inject a faux kernel without fixture files, native settings, or credentials.
	const source = `
		const send = process.send.bind(process);
		process.send = undefined;
		const { installConversationWorker } = await import(${JSON.stringify(workerUrl)});
		const { createModels } = await import("@earendil-works/pi-ai/models");
		const { fauxProvider, fauxAssistantMessage } = await import("@earendil-works/pi-ai/providers/faux");
		const { defineExtension, MemoryStorage } = await import("@earendil-works/pi-durable");
		const models = createModels();
		const faux = fauxProvider();
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("ipc one"), fauxAssistantMessage("ipc two")]);
		installConversationWorker({
			on: (e, l) => process.on(e, l), off: (e, l) => process.off(e, l),
			send: (p) => new Promise((resolve, reject) => send(p, (e) => e ? reject(e) : resolve())),
			exit: (code) => process.exit(code),
		}, {
			openStorage: async () => ({ storage: new MemoryStorage(), release() {} }),
			openAdapter: async () => ({
				models, extension: defineExtension({ name: "ipc-native" }),
				model: { provider: "faux", modelId: "faux-1" }, bindHarness() {}, close: async () => {},
			}),
		});
		send({ type: "installed" });
	`;
	const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
		cwd: process.cwd(),
		stdio: ["ignore", "ignore", "pipe", "ipc"],
	});
	const packets: Array<WorkerPacket | { type: "installed" }> = [];
	let stderr = "";
	let exitCode: number | null | undefined;
	child.stderr!.on("data", (data) => {
		stderr += String(data);
	});
	child.on("message", (packet) => {
		packets.push(packet as WorkerPacket);
	});
	child.on("exit", (code) => {
		exitCode = code;
	});
	try {
		await until(() => packets.some((p) => p.type === "installed") || exitCode !== undefined);
		assert.equal(exitCode, undefined, stderr);
		child.send(launchFor(directory));
		await until(() => packets.some((p) => p.type === "ready"));
		for (const id of ["one", "two"]) {
			child.send(input(id));
			await until(() => packets.some((p) => p.type === "answer" && p.id === id));
			const receipt = packets.find((p) => p.type === "answer" && p.id === id);
			if (receipt?.type !== "answer") assert.fail();
			assert.equal(receipt.result.answer?.text, "ipc " + id);
			assert.equal(exitCode, undefined, stderr);
		}
		child.send({ type: "status", id: "status" });
		await until(() => packets.some((p) => p.type === "status"));
		child.send({ type: "stop", id: "stop" });
		await until(() => packets.some((p) => p.type === "stopped"));
		child.send({ type: "pause" });
		await until(() => exitCode !== undefined);
		assert.equal(exitCode, 0, stderr);
	} finally {
		if (exitCode === undefined) child.kill("SIGKILL");
		await rm(directory, { recursive: true, force: true });
	}
});

for (const stopBeforeResume of [false, true]) {
	test(`SQLite recovery of admission before child delivery ${stopBeforeResume ? "can stop without redelivery" : "delivers exactly once"}`, async () => {
		const directory = await mkdtemp(join(tmpdir(), "persistent-admission-gap-"));
		const file = join(directory, "session.sqlite");
		const { faux, options } = setup();
		faux.setResponses([fauxAssistantMessage("recovered admission")]);
		const storage = await openNodeSqliteStorage(file);
		let runtime: ConversationRuntime;
		let closing: Promise<void> | undefined;
		const observed = new Proxy(storage, {
			get(target, property) {
				if (property === "commit")
					return async (...args: Parameters<Storage["commit"]>) => {
						const seq = await target.commit(...args);
						if (
							args[0].some(
								(write) =>
									write.type === "task" &&
									write.value.kind === "subagents.conversation-reporter" &&
									write.value.state.status === "pending",
							)
						) {
							queueMicrotask(() => {
								closing = runtime.close();
							});
						}
						return seq;
					};
				const value = Reflect.get(target, property);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		runtime = await ConversationRuntime.open(observed, options);
		try {
			await runtime.admit("gap", "persisted expansion").catch(() => undefined);
			assert.ok(closing);
			await closing;
			assert.equal(faux.state.callCount, 0);
			runtime = await ConversationRuntime.open(await openNodeSqliteStorage(file), options);
			assert.equal((await runtime.status()).working, true, "pending Reporter counts before native delivery");
			assert.equal(await runtime.admittedContent("gap"), "persisted expansion");
			if (stopBeforeResume) await runtime.stop();
			const result = await runtime.run("gap", "persisted expansion");
			assert.equal(result.ok, !stopBeforeResume);
			if (stopBeforeResume) assert.deepEqual(result, { ok: false, aborted: true });
			assert.equal(faux.state.callCount, stopBeforeResume ? 0 : 1);
			assert.equal((await runtime.status()).working, false);
		} finally {
			await runtime.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
}

test("status never replaces a completed answer with a partial or explicitly stopped answer", async () => {
	const { faux, options } = setup();
	faux.setResponses([fauxAssistantMessage("canonical answer"), async (_r, stream) => interrupted(stream?.signal)]);
	const runtime = await ConversationRuntime.open(new MemoryStorage(), options);
	try {
		const completed = await runtime.run("done", "done");
		const unfinished = await runtime.admit("unfinished", "unfinished");
		await until(() => faux.state.callCount === 2);
		assert.equal((await runtime.status()).working, true);
		assert.deepEqual((await runtime.status()).lastAnswer, completed.answer);
		await runtime.stop();
		assert.deepEqual(await unfinished.wait(), { ok: false, aborted: true });
		assert.deepEqual((await runtime.status()).lastAnswer, completed.answer);
		assert.equal((await runtime.status()).working, false);
	} finally {
		await runtime.close();
	}
});

test("unchanged managed-package bootstrap binds a real native kernel for persistent offline IPC and reopen", async () => {
	const directory = await mkdtemp(join(tmpdir(), "persistent-peerless-"));
	const installed = join(directory, "package-fixture");
	try {
		await cp(fileURLToPath(new URL("../", import.meta.url)), join(installed, "extensions"), {
			recursive: true,
			filter: (path) => !path.endsWith(".test.ts") && !path.includes("/fixtures/"),
		});
		await writeFile(join(installed, "package.json"), JSON.stringify({ type: "module" }));
		await mkdir(join(installed, "node_modules", "@earendil-works"), { recursive: true });
		for (const name of ["chord", "pi-durable"])
			await symlink(
				fileURLToPath(new URL(`../../node_modules/@earendil-works/${name}`, import.meta.url)),
				join(installed, "node_modules", "@earendil-works", name),
				"dir",
			);
		await assert.rejects(access(join(installed, "node_modules", "@earendil-works", "pi-coding-agent")));
		const fixture = join(directory, "offline.ts");
		await writeFile(
			fixture,
			`
			import { fauxProvider, fauxAssistantMessage } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai/providers/faux"))};
			export default function(pi) {
				const faux = fauxProvider();
				faux.setResponses(Array.from({ length: 3 }, () => (request) => fauxAssistantMessage(
					JSON.stringify(request.messages.filter((m) => m.role === "user").map((m) => m.content)))));
				pi.registerProvider(faux.provider);
			}
		`,
		);
		await writeFile(
			join(directory, "settings.json"),
			JSON.stringify({
				extensions: [fixture],
				defaultProvider: "faux",
				defaultModel: "faux-1",
				cacheWarming: "off",
			}),
		);
		const command = launchFor(directory);
		command.spec.request.overrides = { model: "faux/faux-1" };
		const open = () => {
			const child = spawn(process.execPath, [join(installed, "extensions", "subagents", "worker-bootstrap.mjs")], {
				cwd: directory,
				detached: true,
				stdio: ["ignore", "ignore", "pipe", "ipc"],
				env: {
					...process.env,
					PI_OFFLINE: "1",
					PI_CODING_AGENT_DIR: directory,
					PI_CODE_MODE_SUBAGENT: "1",
					PI_SUBAGENT_HOST_PACKAGE_DIR: getPackageDir(),
				},
			});
			const packets: WorkerPacket[] = [];
			let closed = false;
			let stderr = "";
			child.stderr!.on("data", (chunk) => {
				stderr += String(chunk);
			});
			child.on("message", (packet) => {
				packets.push(packet as WorkerPacket);
			});
			child.on("close", () => {
				closed = true;
			});
			const cleanup = async () => {
				if (!closed) {
					try {
						process.kill(-child.pid!, "SIGKILL");
					} catch {
						child.kill("SIGKILL");
					}
					await until(() => closed);
				}
			};
			const waitPacket = async (type: WorkerPacket["type"], id?: string) => {
				await until(() => closed || packets.some((p) => p.type === type && (!id || ("id" in p && p.id === id))));
				const packet = packets.find((p) => p.type === type && (!id || ("id" in p && p.id === id)));
				assert.ok(packet, stderr || JSON.stringify(packets));
				return packet;
			};
			return {
				child,
				packets,
				cleanup,
				waitPacket,
				get closed() {
					return closed;
				},
			};
		};
		const first = open();
		let conversationId: string;
		try {
			first.child.send(command);
			const ready = await first.waitPacket("ready");
			if (ready.type !== "ready") assert.fail();
			conversationId = ready.status.conversationId;
			assert.equal(ready.status.working, false);
			for (const id of ["boot-one", "boot-two"]) {
				first.child.send(input(id));
				await first.waitPacket("accepted", id);
				const answer = await first.waitPacket("answer", id);
				if (answer.type !== "answer") assert.fail();
				assert.equal(answer.result.ok, true, JSON.stringify(answer));
				assert.match(answer.result.answer!.text, /boot-one/);
				if (id === "boot-two") assert.match(answer.result.answer!.text, /boot-two/);
				assert.equal(first.closed, false);
			}
			first.child.send({ type: "pause" });
			await first.waitPacket("paused");
			await until(() => first.closed);
		} finally {
			await first.cleanup();
		}
		command.spec.request.overrides = { model: "unavailable/new-host-default" };
		const second = open();
		try {
			second.child.send(command);
			const ready = await second.waitPacket("ready");
			if (ready.type !== "ready") assert.fail();
			assert.equal(ready.status.conversationId, conversationId!);
			second.child.send(input("boot-three"));
			const answer = await second.waitPacket("answer", "boot-three");
			if (answer.type !== "answer") assert.fail();
			assert.equal(answer.result.ok, true, JSON.stringify(answer));
			for (const message of ["boot-one", "boot-two", "boot-three"])
				assert.match(answer.result.answer!.text, new RegExp(message));
			second.child.send({ type: "pause" });
			await second.waitPacket("paused");
			await until(() => second.closed);
		} finally {
			await second.cleanup();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("cancel aborts admitted work without waiting for a blocked native input handler", async () => {
	const directory = await mkdtemp(join(tmpdir(), "persistent-cancel-expansion-"));
	const { faux, options } = setup();
	const host = workerHost();
	let signal: AbortSignal | undefined;
	let blocked = false;
	let release!: () => void;
	const expansion = new Promise<void>((resolve) => {
		release = resolve;
	});
	faux.setResponses([
		async (_r, stream) => {
			signal = stream?.signal;
			return interrupted(signal);
		},
	]);
	installConversationWorker(host.host, {
		openStorage: openDurableStorage,
		openAdapter: async () => ({
			...options,
			bindHarness() {},
			close: async () => {},
			prepareInput: async (content) => {
				if (content === "blocked") {
					blocked = true;
					await expansion;
				}
				return content;
			},
		}),
	});
	try {
		host.events.emit("message", launchFor(directory));
		host.events.emit("message", input("active"));
		await until(() => host.packets.some((p) => p.type === "accepted"));
		host.events.emit("message", input("blocked"));
		await until(() => blocked && !!signal);
		host.events.emit("message", { type: "cancel" });
		await until(() => !!signal?.aborted);
		release();
		await until(() => host.code !== undefined);
		assert.equal(host.code, 0);
		const owned = await openDurableStorage(join(directory, "private"));
		const runtime = await ConversationRuntime.open(owned.storage, options);
		try {
			assert.deepEqual(await runtime.run("active", "active"), { ok: false, aborted: true });
			assert.equal(await runtime.admittedContent("blocked"), undefined);
		} finally {
			await runtime.close();
			owned.release();
		}
	} finally {
		release();
		await pause(host);
		await rm(directory, { recursive: true, force: true });
	}
});

for (const retainedStop of [true, false]) {
	test(`worker recovery withdraws ${retainedStop ? "retained stop intent" : "expired lifetime"} before resuming generation`, async () => {
		const directory = await mkdtemp(join(tmpdir(), "worker-stop-before-resume-"));
		const { faux, options } = setup();
		faux.setResponses([async (_r, stream) => interrupted(stream?.signal), fauxAssistantMessage("new work")]);
		const command = launchFor(directory);
		const hosts = [workerHost(), workerHost()];
		const deps = {
			openStorage: openDurableStorage,
			openAdapter: async (): Promise<WorkerAdapter> => ({ ...options, bindHarness() {}, close: async () => {} }),
		};
		try {
			const first = hosts[0]!,
				second = hosts[1]!;
			installConversationWorker(first.host, deps);
			first.events.emit("message", command);
			first.events.emit("message", input("pending", "working"));
			await until(() => faux.state.callCount === 1);
			await pause(first);
			installConversationWorker(second.host, deps);
			second.events.emit("message", {
				...command,
				spec: {
					...command.spec,
					stopOnOpen: retainedStop,
					context: {
						...command.spec.context,
						...(retainedStop ? {} : { deadlineAt: Date.now() - 1 }),
					},
				},
			});
			await until(() => second.packets.some((p) => p.type === "ready"));
			await until(() => answers(second).some((p) => p.id === "pending"));
			assert.equal(faux.state.callCount, 1, "recovery must not restart an expired/withdrawn model request");
			assert.deepEqual(answers(second)[0]!.result, { ok: false, aborted: true });
			second.events.emit("message", input("new", "new work"));
			await until(() => answers(second).some((p) => p.id === "new"));
			assert.equal(answers(second).find((p) => p.id === "new")!.result.answer?.text, "new work");
		} finally {
			for (const host of hosts) await pause(host);
			await rm(directory, { recursive: true, force: true });
		}
	});
}
