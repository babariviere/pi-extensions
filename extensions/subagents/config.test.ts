import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SUBAGENTS_CONFIG, MAX_AGENT_TIMEOUT_MS, normalizeSubagentsConfig } from "./config.ts";

test("subagents defaults contain no executor or legacy agents wrapper", () => {
	assert.deepEqual(normalizeSubagentsConfig({}), { maxPerExecution: 100, timeoutMs: 7_200_000 });
	assert.deepEqual(
		normalizeSubagentsConfig({ agents: { timeoutMs: 1 }, executor: { timeoutMs: 1 } }),
		DEFAULT_SUBAGENTS_CONFIG,
	);
});

test("subagent policy clamps integer limits and rejects malformed values", () => {
	assert.deepEqual(normalizeSubagentsConfig({ maxPerExecution: 0, timeoutMs: 1, waitMs: 0 }), {
		maxPerExecution: 1,
		timeoutMs: 1_000,
	});
	assert.deepEqual(
		normalizeSubagentsConfig({
			maxPerExecution: 2_000,
			timeoutMs: MAX_AGENT_TIMEOUT_MS + 1,
			waitMs: MAX_AGENT_TIMEOUT_MS + 1,
		}),
		{ maxPerExecution: 1_000, timeoutMs: MAX_AGENT_TIMEOUT_MS },
	);
	for (const value of ["1000", null, NaN, Infinity, 1.5]) {
		assert.deepEqual(
			normalizeSubagentsConfig({ maxPerExecution: value, timeoutMs: value, waitMs: value }),
			DEFAULT_SUBAGENTS_CONFIG,
		);
	}
});

test("subagents model and thinking defaults are optional and validated", () => {
	assert.deepEqual(normalizeSubagentsConfig({ defaultModel: " parent/model ", defaultThinking: "high" }), {
		...DEFAULT_SUBAGENTS_CONFIG,
		defaultModel: "parent/model",
		defaultThinking: "high",
	});
	assert.deepEqual(
		normalizeSubagentsConfig({ defaultModel: " ", defaultThinking: "invalid" }),
		DEFAULT_SUBAGENTS_CONFIG,
	);
});

test("legacy backend selection is ignored by the default-only durable configuration", () => {
	for (const backend of [undefined, "durable", "auto", "headless", "herdr", "Durable", true]) {
		assert.deepEqual(normalizeSubagentsConfig({ backend }), DEFAULT_SUBAGENTS_CONFIG);
	}
});
