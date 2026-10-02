import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	createCodemodeExtension,
	type ExtensionAPI,
	ModelRegistry,
	ModelRuntime,
	type ProviderConfig,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { MODEL_SPECS } from "./config.ts";
import clef from "./index.ts";
import { ClefWorker } from "./worker.ts";

test("native Pi catalog and codemode reach the local classifier without chat selection or remote credentials", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "native-clef-"));
	const originalRequest = ClefWorker.prototype.request;
	try {
		const runtime = await ModelRuntime.create({
			authPath: join(cwd, "auth.json"),
			modelsPath: null,
			modelsStorePath: join(cwd, "models-cache.json"),
			refreshOnCreate: false,
			allowModelNetwork: false,
		});
		const registry = new ModelRegistry(runtime);
		let calls = 0;
		ClefWorker.prototype.request = async (payload) => {
			calls++;
			assert.equal((payload as { questions: { urgent: { type: string } } }).questions.urgent.type, "noul");
			return { probabilities: { urgent: { true: 0.9, false: 0.1 } }, inputTokens: 100 };
		};
		clef({
			registerProvider: (name: string, config: ProviderConfig) => registry.registerProvider(name, config),
			registerCommand: () => {},
			on: () => () => {},
		} as unknown as ExtensionAPI);
		const available = await registry.getAvailableOfType("classifier", "clef");
		assert.deepEqual(
			available.map((model) => model.id),
			[MODEL_SPECS.flash.id],
		);
		assert.equal(registry.getModelsOfType("chat", "clef").length, 0);
		let codemode: ToolDefinition<any, any> | undefined;
		createCodemodeExtension()({
			registerTool: (tool: ToolDefinition<any, any>) => {
				codemode = tool;
			},
			getAllTools: () => [],
			getSettings: () => ({}),
			appendEntry: () => {},
		} as unknown as ExtensionAPI);
		const result = await codemode!.execute(
			"native-clef",
			{
				code: `const clef = await models.getModelOfType("classifier", "clef", "clef-flash-4bit");
return await models.classify(clef, { state: { message: "Checkout is down" }, questions: {
urgent: { type: "bool", instructions: "Urgent?", criteria: { true: "Outage", false: "Nonurgent" } }
} });`,
			},
			undefined,
			undefined,
			{
				cwd,
				tools: [],
				modelRegistry: registry,
				sessionManager: { getBranch: () => [] },
			} as never,
		);
		assert.notEqual(result.isError, true);
		assert.equal(calls, 1);
		const output = result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
		assert.match(output, /"probability"\s*:\s*0.9/);
		assert.match(output, /"stopReason"\s*:\s*"stop"/);
	} finally {
		ClefWorker.prototype.request = originalRequest;
		rmSync(cwd, { recursive: true, force: true });
	}
});
