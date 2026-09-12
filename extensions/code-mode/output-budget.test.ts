import assert from "node:assert/strict";
import { test } from "node:test";

import { boundModelOutput, MAX_FAILURE_MODEL_OUTPUT_CHARS, modelOutputBudget } from "./output-budget.ts";

test("a failing execution gets the tighter budget", () => {
	assert.equal(modelOutputBudget(100_000, true), 100_000);
	assert.equal(modelOutputBudget(100_000, false), MAX_FAILURE_MODEL_OUTPUT_CHARS);
	assert.equal(modelOutputBudget(1_000, false), 1_000);
});

test("output within budget passes through untouched", async () => {
	const bounded = await boundModelOutput("short", 100);
	assert.equal(bounded.text, "short");
	assert.equal(bounded.artifactPath, undefined);
	assert.equal(bounded.omittedChars, 0);
});

test("oversized output spills to an artifact and names its path", async () => {
	const written: string[] = [];
	const bounded = await boundModelOutput("x".repeat(5_000), 500, "x".repeat(5_000), async (content) => {
		written.push(content);
		return "/tmp/spindle-test/output.txt";
	});
	assert.equal(written.length, 1);
	assert.equal(written[0]?.length, 5_000);
	assert.ok(bounded.text.length <= 500);
	assert.match(bounded.text, /Full output \(5000 chars\) saved to: \/tmp\/spindle-test\/output\.txt/);
	assert.equal(bounded.artifactPath, "/tmp/spindle-test/output.txt");
});

test("a failing artifact writer still returns bounded text", async () => {
	const bounded = await boundModelOutput("y".repeat(2_000), 200, "y".repeat(2_000), async () => {
		throw new Error("disk full");
	});
	assert.ok(bounded.text.length <= 200);
	assert.equal(bounded.artifactPath, undefined);
});
