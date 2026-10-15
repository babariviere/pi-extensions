import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore, Type } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { builtinAgent } from "../extensions/subagents/discovery.ts";
import { NativeAdapter } from "../extensions/subagents/native-adapter.ts";
import { ConversationRuntime } from "../extensions/subagents/conversation-runtime.ts";
import { SubscriptionGate } from "./subscription-gate.mjs";

const gate = () => {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
};

test("native child quota holds new requests/tools and does not deadlock a host tool drain", {
	timeout: 20_000,
}, async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "child-subscription-"));
	const policyPath = join(dir, "policy.json");
	for (const [key, value] of Object.entries({
		PILOT_SUBSCRIPTION_POLICY: policyPath,
		PI_OFFLINE: "1",
		PI_CODING_AGENT_DIR: dir,
		PI_CODE_MODE_SUBAGENT: "1",
	})) {
		const previous = process.env[key];
		process.env[key] = value;
		t.after(() => {
			if (previous === undefined) delete process.env[key];
			else process.env[key] = previous;
		});
	}
	const window = {
		provider: "openai",
		label: "5h",
		usedPercent: 95,
		resetsAt: new Date(Date.now() + 60_000).toISOString(),
	};
	const save = (windows: unknown[], forced: string[] = []) =>
		writeFile(policyPath, JSON.stringify({ version: 1, windows, forced }));
	await save([]);
	const started = gate(),
		finish = gate();
	let calls = 0;
	const faux = fauxProvider({ provider: "openai-codex", models: [{ id: "offline" }] });
	const models = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		modelsStorePath: join(dir, "models.json"),
		refreshOnCreate: false,
	});
	models.registerNativeProvider(faux.provider);
	const adapter = await NativeAdapter.open(
		{ agent: builtinAgent(), task: "offline", index: 0 },
		{
			cwd: dir,
			runId: "test",
			timeoutMs: 20_000,
			projectTrusted: false,
			sessionId: undefined,
			sessionFile: undefined,
		},
		{
			agentDir: dir,
			settingsManager: SettingsManager.inMemory({ defaultTools: ["effect"] }),
			loaderOptions: {
				cwd: dir,
				agentDir: dir,
				noExtensions: true,
				noSkills: true,
				noThemes: true,
				noPromptTemplates: true,
				noContextFiles: true,
			},
			sessionOptions: {
				modelRuntime: models,
				model: faux.getModel(),
				customTools: [
					{
						name: "effect",
						label: "effect",
						description: "offline effect",
						parameters: Type.Object({}),
						execute: async () => {
							calls++;
							if (calls === 1) {
								started.resolve();
								await finish.promise;
							}
							return { content: [{ type: "text", text: "saved" }], details: {} };
						},
					},
				],
			},
		},
	);
	let runtime: ConversationRuntime | undefined;
	try {
		runtime = await ConversationRuntime.open(new MemoryStorage(), {
			models: adapter.models,
			extension: adapter.extension,
			model: adapter.model,
			cwd: dir,
			beforeToolAdmission: (context) => adapter.waitForSubscription(context.abortSignal),
		});
		adapter.bindHarness(runtime.harness, runtime.conversationId);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("effect", {}), fauxToolCall("effect", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		runtime.resume();
		await runtime.admit("work", "work", false);
		await started.promise;
		await save([window]);
		const paused = runtime.quiesce();
		finish.resolve();
		await paused;
		assert.equal(calls, 1, "only the admitted effect finishes");
		assert.equal(faux.state.callCount, 1);
		// Compaction also calls Models directly, outside GenerationTask hooks.
		const entered = gate();
		const wait = SubscriptionGate.prototype.wait;
		const spy = t.mock.method(
			SubscriptionGate.prototype,
			"wait",
			async function (this: SubscriptionGate, provider: string | undefined, signal?: AbortSignal) {
				entered.resolve();
				return wait.call(this, provider, signal);
			},
		);
		const cancel = new AbortController();
		const compacting = adapter.models.completeSimple(faux.getModel(), { messages: [] }, { signal: cancel.signal });
		await entered.promise;
		assert.equal(faux.state.callCount, 1, "direct model calls cannot bypass quota");
		cancel.abort();
		assert.equal((await compacting).stopReason, "aborted");
		spy.mock.restore();
		await save([window], [JSON.stringify(["openai", "5h", window.resetsAt])]);
		runtime.resumeTools();
		await runtime.child.waitForIdle(BACKGROUND_CONTEXT);
		assert.equal(calls, 2);
		assert.equal(faux.state.callCount, 2);
	} finally {
		finish.resolve();
		await runtime?.close();
		await adapter.close();
		await rm(dir, { recursive: true, force: true });
	}
});
