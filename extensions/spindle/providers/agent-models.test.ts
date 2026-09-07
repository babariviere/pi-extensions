import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { SpindleAgentRunRegistry } from "./agent-run-monitor.ts";
import { SpindleAgentsProvider, type SpindleAgentRuntimeConfig } from "./agents-provider.ts";

const model = (id: string, price: number, provider = "parent"): Model<any> =>
	({
		id,
		provider,
		name: id,
		api: "openai-completions",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 128000,
		maxTokens: 8000,
		cost: { input: price, output: price, cacheRead: 0, cacheWrite: 0 },
		baseUrl: "https://private.invalid",
		headers: { Authorization: "secret" },
	}) as Model<any>;

test("models filters live runtime metadata by launch policy without exposing connection details", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "spindle-models-"));
	try {
		mkdirSync(join(cwd, ".pi"));
		const settings = join(cwd, ".pi", "settings.json");
		writeFileSync(settings, JSON.stringify({ enabledModels: [] }));
		const catalog = [
			model("claude-opus-5", 10),
			model("gpt-5.6-sol", 8),
			model("cheap", 1),
			model("expensive", 100),
			model("foreign", 1, "other"),
			{ ...model("unpriced", 1), cost: undefined } as unknown as Model<any>,
		];
		let runtime: SpindleAgentRuntimeConfig = {
			timeoutMs: 1000,
			waitMs: 0,
			parentProvider: "parent",
			defaultModel: "cheap",
			models: catalog,
		};
		const provider = new SpindleAgentsProvider(
			() => ({ cwd, sessionId: undefined, sessionFile: undefined }),
			new SpindleAgentRunRegistry(),
			() => runtime,
		);
		const list = async () =>
			(await provider.invoke("models", {}, {} as never)) as {
				defaultModel: string | null;
				models: Array<Record<string, unknown>>;
			};
		assert.ok(await provider.describe("models", {} as never));
		const result = await list();
		assert.equal(result.defaultModel, "parent/cheap");
		assert.deepEqual(
			result.models.map((m) => m.id),
			["parent/claude-opus-5", "parent/gpt-5.6-sol", "parent/cheap"],
		);
		assert.deepEqual(result.models[2], {
			id: "parent/cheap",
			name: "cheap",
			provider: "parent",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 128000,
			maxTokens: 8000,
		});
		writeFileSync(settings, JSON.stringify({ enabledModels: ["parent/cheap"] }));
		assert.deepEqual(
			(await list()).models.map((m) => m.id),
			["parent/cheap"],
		);
		runtime = { ...runtime, parentProvider: "other" };
		assert.deepEqual((await list()).models, []);
		runtime = { ...runtime, parentProvider: "parent", models: catalog.slice(1) };
		assert.deepEqual((await list()).models, [], "missing reference pricing fails closed");
		runtime = { timeoutMs: 1000, waitMs: 0 };
		assert.deepEqual(await list(), { defaultModel: null, models: [] });
		assert.deepEqual(provider.runs.list(), [], "discovery never launches a child");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
