import assert from "node:assert/strict";
import { test } from "node:test";
import { extractAccountedUsage, sumAccountedUsage } from "./usage-accounting.ts";

test("extracts assistant usage using Pi's input/output fields with legacy fallback", () => {
	assert.deepEqual(
		extractAccountedUsage({
			type: "message",
			message: {
				role: "assistant",
				provider: "provider",
				model: "model",
				usage: { input: 10, output: 4, cacheRead: 3, cacheWrite: 2, cost: { total: 0.75 } },
			},
		}),
		{
			source: "assistant",
			provider: "provider",
			model: "model",
			input: 10,
			output: 4,
			cacheRead: 3,
			cacheWrite: 2,
			cost: 0.75,
		},
	);
	assert.equal(
		extractAccountedUsage({
			type: "message",
			message: { role: "assistant", usage: { inputTokens: 5, outputTokens: 6 } },
		})?.input,
		5,
	);
});

test("groups non-assistant usage honestly and accepts arbitrary usage kinds", () => {
	assert.deepEqual(
		extractAccountedUsage({
			type: "message",
			message: { role: "toolResult", toolName: "agents_run", usage: { input: 8, output: 3 } },
		}),
		{
			source: "tool",
			provider: "tool",
			model: "agents_run",
			input: 8,
			output: 3,
			cacheRead: 0,
			cacheWrite: 0,
		},
	);
	assert.equal(
		extractAccountedUsage({
			type: "usage",
			kind: "future_kind",
			provider: "provider",
			model: "model",
			usage: { input: 2 },
		})?.kind,
		"future_kind",
	);
	assert.equal(extractAccountedUsage({ type: "compaction", usage: { input: 1 } })?.model, "compaction");
	assert.equal(extractAccountedUsage({ type: "branch_summary", usage: { output: 7 } })?.model, "branch_summary");
});

test("sums all session usage categories and uses recorded cost without repricing", () => {
	const totals = sumAccountedUsage([
		{ type: "message", message: { role: "assistant", usage: { input: 10, output: 4, cost: { total: 0.42 } } } },
		{ type: "message", message: { role: "toolResult", toolName: "read", usage: { input: 2, output: 1 } } },
		{ type: "usage", kind: "unknown", provider: "p", model: "m", usage: { cacheRead: 5, cost: { cacheRead: 9 } } },
		{ type: "compaction", usage: { input: 3, output: 1, cost: { input: 2, output: 1 } } },
		{ type: "branch_summary", usage: { input: 1 } },
	]);
	assert.deepEqual(totals, {
		input: 16,
		output: 6,
		cacheRead: 5,
		cacheWrite: 0,
		totalTokens: 27,
		totalCost: 12.42,
	});
});
