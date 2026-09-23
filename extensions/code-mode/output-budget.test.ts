import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
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
		return "/tmp/code-mode-test/output.txt";
	});
	assert.equal(written.length, 1);
	assert.equal(written[0]?.length, 5_000);
	assert.ok(bounded.text.length <= 500);
	assert.match(bounded.text, /Full output \(5000 chars\) saved to: \/tmp\/code-mode-test\/output\.txt/);
	assert.equal(bounded.artifactPath, "/tmp/code-mode-test/output.txt");
	assert.match(bounded.text, /Read in smaller ranges with pi\.read/);
});

test("the real spill keeps the entire return available across calls", async () => {
	const fullOutput = "a".repeat(20_000) + "END";
	const bounded = await boundModelOutput(fullOutput, 1_000);
	assert.ok(bounded.artifactPath);
	try {
		assert.equal(readFileSync(bounded.artifactPath, "utf8"), fullOutput);
		assert.ok(bounded.text.length <= 1_000);
	} finally {
		rmSync(dirname(bounded.artifactPath), { recursive: true, force: true });
	}
});

test("a failing artifact writer still returns bounded text", async () => {
	const bounded = await boundModelOutput("y".repeat(2_000), 200, "y".repeat(2_000), async () => {
		throw new Error("disk full");
	});
	assert.ok(bounded.text.length <= 200);
	assert.equal(bounded.artifactPath, undefined);
});
