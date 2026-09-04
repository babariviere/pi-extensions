import assert from "node:assert/strict";
import test from "node:test";
import { isOpenAIModel, usageProviderForModel } from "./protocol.ts";
import { parseOpenAIUsage } from "./source.ts";

test("recognizes Codex subscription models", () => {
	assert.equal(isOpenAIModel({ provider: "openai-codex", id: "gpt-5-codex" }), true);
	assert.equal(isOpenAIModel({ provider: "openai", id: "gpt-5" }), false);
	assert.equal(usageProviderForModel({ provider: "openai-codex", id: "gpt-5-codex" }), "openai");
});

test("parses Codex usage windows by duration", () => {
	const snapshot = parseOpenAIUsage({
		rate_limit: {
			primary_window: { used_percent: 12.5, limit_window_seconds: 604800, reset_at: 1_800_000_000 },
			secondary_window: { used_percent: 4, limit_window_seconds: 18000, reset_at: 1_700_000_000 },
		},
	});
	assert.equal(snapshot.provider, "openai");
	assert.deepEqual(snapshot.windows, [
		{ label: "Week", usedPercent: 12.5, resetsAt: "2027-01-15T08:00:00.000Z" },
		{ label: "5h", usedPercent: 4, resetsAt: "2023-11-14T22:13:20.000Z" },
	]);
});
