import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness, hook, ToolTask } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { ToolDrain } from "./tool-drain.mjs";

const context = BACKGROUND_CONTEXT;
const gate = () => {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
};

test("drain waits for committed tool results, preserves not-yet-started calls and resumes SQLite work", {
	timeout: 10_000,
}, async () => {
	const directory = await mkdtemp(join(tmpdir(), "tool-drain-"));
	const started = gate(),
		finish = gate(),
		afterTool = gate(),
		settle = gate();
	let calls = 0;
	const extension = defineExtension({
		name: "test-native",
		tools: [
			defineTool({
				name: "effect",
				parameters: Type.Object({}),
				description: "Test effect",
				replay: "unsafe",
				executionMode: "sequential",
				execute: async () => {
					calls++;
					if (calls === 1) {
						started.resolve();
						await finish.promise;
					}
					return { content: [{ type: "text", text: "saved" }] };
				},
			}),
		],
		hooks: [
			hook(ToolTask, {
				afterTool: async () => {
					if (calls === 1) {
						afterTool.resolve();
						await settle.promise;
					}
				},
			}),
		],
	});
	const models = createModels(),
		faux = fauxProvider();
	models.setProvider(faux.provider);
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("effect", {}, { id: "one" }), fauxToolCall("effect", {}, { id: "two" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("done"),
	]);
	let harness: Harness | undefined;
	const open = async () => {
		const drain = new ToolDrain(),
			registry = createRegistry();
		registry.install(drain.prepare(extension));
		harness = await Harness.open(
			await openNodeSqliteStorage(join(directory, "session.sqlite")),
			{ models, registry, settings: { toolExecution: "sequential" } },
			context,
		);
		return {
			drain,
			root: await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } }),
		};
	};
	try {
		const first = await open();
		await first.root.submit({ type: "input", content: "work", requestId: "stable" }, context);
		await started.promise;
		let paused = false;
		const pause = first.drain.pause(harness!, context).then(() => {
			paused = true;
		});
		finish.resolve();
		await afterTool.promise;
		assert.equal(paused, false, "execute returning is not a durable result");
		settle.resolve();
		await pause;
		assert.equal(calls, 1, "the second call freezes before unsafe intent");
		assert.equal(faux.state.callCount, 1, "no next model request while paused");
		assert.equal(
			(await first.root.entries({}, 100, undefined, context)).items.filter((e) => e.kind === "pi.tool-result")
				.length,
			1,
		);
		await harness!.close(context);
		const next = await open();
		harness!.resume();
		await next.root.waitForIdle(context);
		assert.equal(calls, 2, "completed effects are never replayed and unstarted calls are not interrupted");
		const entries = (await next.root.entries({}, 100, undefined, context)).items;
		assert.equal(entries.filter((e) => e.kind === "pi.tool-result").length, 2);
		assert.ok(!JSON.stringify(entries).includes("interrupted"));
	} finally {
		finish.resolve();
		settle.resolve();
		await harness?.close(context);
		await rm(directory, { recursive: true, force: true });
	}
});
