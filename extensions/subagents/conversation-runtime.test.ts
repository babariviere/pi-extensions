import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
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
		assert.equal(first.output, "first answer");
		assert.equal(first.ok, true);
		const next = await runtime.run("second", "second");
		assert.equal(next.conversationId, first.conversationId);
		assert.equal(next.output, "second answer");
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
		assert.equal(result.output, "resumed answer");
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
		assert.equal(result.output, "checkpointed answer");
		assert.equal(faux.state.callCount, 1);
		assert.equal((await entries(runtime, true)).length, 1);
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
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
		task: "offline task",
		index: 0,
		output: join(directory, "result.md"),
	};
	const context: RunContext = {
		cwd: directory,
		sessionFile: join(directory, "parent.jsonl"),
		sessionId: "parent",
		runId: "worker-test",
		timeoutMs: 60_000,
	};
	return {
		type: "start" as const,
		request,
		context,
		directory: join(directory, "private"),
		requestId: "worker-input",
	};
}

test("worker binds before generation, sends durable result, persists output, and closes kernel after Harness", async () => {
	const directory = await mkdtemp(join(tmpdir(), "conversation-worker-result-"));
	const { faux, options } = setup();
	const host = workerHost();
	let bound: Harness | undefined;
	let closed = false;
	const adapter: WorkerAdapter = {
		...options,
		bindHarness: (harness) => {
			bound = harness;
		},
		prepareInput: async (content) => {
			assert.match(content, /^Task: offline task/);
			assert.match(content, /complete findings in your final message/);
			return content;
		},
		close: async () => {
			await assert.rejects(bound!.inspect(ctx), /closed/);
			closed = true;
		},
	};
	faux.setResponses([
		(request) => {
			assert.ok(bound, "adapter was bound before request");
			assert.ok(request.messages.some((message) => message.role === "user"));
			return fauxAssistantMessage("worker answer");
		},
	]);
	installConversationWorker(host.host, { openStorage: openDurableStorage, openAdapter: async () => adapter });
	try {
		host.events.emit("message", launchFor(directory));
		await until(() => host.code !== undefined);
		assert.equal(host.code, 0);
		assert.equal(closed, true);
		assert.equal(host.packets.length, 1);
		const packet = host.packets[0]!;
		assert.equal(packet.type, "result");
		if (packet.type !== "result") assert.fail("Missing result");
		assert.equal(packet.result.backend, "durable");
		assert.equal(typeof packet.result.conversationId, "string");
		assert.equal(packet.result.ok, true);
		assert.equal(await readFile(packet.result.outputPath!, "utf8"), "worker answer");
		assert.equal((await stat(packet.result.outputPath!)).mode & 0o777, 0o600);
		assert.equal(faux.state.callCount, 1);
	} finally {
		if (host.code === undefined) host.events.emit("message", { type: "pause" });
		await until(() => host.code !== undefined);
		await rm(directory, { recursive: true, force: true });
	}
});

for (const stop of ["pause", "cancel", "disconnect", "SIGTERM"] as const) {
	test(`worker ${stop} closes cleanly and ${stop === "cancel" ? "aborts" : "preserves"} durable pending work`, async () => {
		const directory = await mkdtemp(join(tmpdir(), "conversation-worker-stop-"));
		const { faux, options } = setup();
		faux.setResponses([
			async (_request, stream) => interrupted(stream?.signal),
			fauxAssistantMessage("recovered worker"),
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
			await until(() => faux.state.callCount === 1);
			if (stop === "pause" || stop === "cancel") host.events.emit("message", { type: stop });
			else host.events.emit(stop);
			await until(() => host.code !== undefined);
			assert.equal(host.code, 0);
			assert.equal(nativeClosed, true);
			if (stop === "cancel") {
				const packet = host.packets[0]!;
				assert.equal(packet.type, "result");
				if (packet.type !== "result") assert.fail("Missing cancellation result");
				assert.equal(packet.result.failure, "cancelled");
			} else assert.deepEqual(host.packets, stop === "disconnect" ? [] : [{ type: "paused" }]);
			const owned = await openDurableStorage(command.directory);
			const runtime = await ConversationRuntime.open(owned.storage, options);
			try {
				// Framing must match worker admission on recovery.
				const admission = await owned.storage.submissionByRequest(runtime.conversationId, command.requestId, ctx);
				assert.ok(admission);
				const content = (await entries(runtime)).find((entry) => entry.kind === "pi.user")!.model![0]!;
				assert.equal(content.role, "user");
				if (content.role !== "user" || typeof content.content !== "string") assert.fail("Missing admitted content");
				const result = await runtime.run(command.requestId, content.content);
				assert.equal(result.ok, stop !== "cancel");
				assert.equal(faux.state.callCount, stop === "cancel" ? 1 : 2);
				assert.equal((await entries(runtime)).filter((entry) => entry.kind === "pi.user").length, 1);
			} finally {
				await runtime.close();
				owned.release();
			}
		} finally {
			if (host.code === undefined) host.events.emit("message", { type: "pause" });
			await until(() => host.code !== undefined);
			await rm(directory, { recursive: true, force: true });
		}
	});
}

test("worker recovery waits for a closing owner without starting a concurrent native kernel", async () => {
	const directory = await mkdtemp(join(tmpdir(), "conversation-worker-owner-"));
	const { faux, options } = setup();
	faux.setResponses([fauxAssistantMessage("recovered owner")]);
	const command = launchFor(directory);
	const owned = await openDurableStorage(command.directory);
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
		assert.equal(kernels, 0, "existing owner must exclude every new native tool kernel");
		await owned.storage.close(ctx);
		owned.release();
		await until(() => host.code !== undefined);
		assert.equal(kernels, 1);
		const packet = host.packets[0]!;
		assert.equal(packet.type, "result");
		if (packet.type !== "result") assert.fail("Missing recovery result");
		assert.equal(packet.result.ok, true, packet.result.error ?? "Recovery failed");
	} finally {
		owned.release();
		if (host.code === undefined) host.events.emit("message", { type: "pause" });
		await until(() => host.code !== undefined);
		await rm(directory, { recursive: true, force: true });
	}
});

test("worker recovery reuses persisted native input expansion instead of running input handlers twice", async () => {
	const directory = await mkdtemp(join(tmpdir(), "conversation-worker-expansion-"));
	const { faux, options } = setup();
	faux.setResponses([
		async (_request, stream) => interrupted(stream?.signal),
		fauxAssistantMessage("recovered expansion"),
	]);
	let expansions = 0;
	const deps = {
		openStorage: openDurableStorage,
		openAdapter: async (): Promise<WorkerAdapter> => ({
			...options,
			bindHarness() {},
			close: async () => {},
			prepareInput: async (content) => `${++expansions}:${content}`,
		}),
	};
	const first = workerHost();
	const second = workerHost();
	const command = launchFor(directory);
	try {
		installConversationWorker(first.host, deps);
		first.events.emit("message", command);
		await until(() => faux.state.callCount === 1);
		first.events.emit("message", { type: "pause" });
		await until(() => first.code !== undefined);
		installConversationWorker(second.host, deps);
		second.events.emit("message", command);
		await until(() => second.code !== undefined);
		const packet = second.packets[0]!;
		assert.equal(packet.type, "result");
		if (packet.type !== "result") assert.fail("Missing resumed result");
		assert.equal(packet.result.ok, true);
		assert.equal(expansions, 1);
		assert.equal(faux.state.callCount, 2);
	} finally {
		for (const host of [first, second]) {
			if (host.code === undefined) host.events.emit("message", { type: "pause" });
		}
		await until(() => first.code !== undefined && second.code !== undefined);
		await rm(directory, { recursive: true, force: true });
	}
});
