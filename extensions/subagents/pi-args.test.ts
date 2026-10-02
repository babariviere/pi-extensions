import assert from "node:assert/strict";
import { test } from "node:test";
import { extractThinkingSuffix, qualifyModel, stripThinkingSuffix, formatTaskMessage } from "./pi-args.ts";

test("stripThinkingSuffix removes a known thinking suffix and leaves other colons alone", () => {
	assert.equal(stripThinkingSuffix("claude-opus-4-8:low"), "claude-opus-4-8");
	assert.equal(stripThinkingSuffix("anthropic/claude-opus-4-8:high"), "anthropic/claude-opus-4-8");
	assert.equal(stripThinkingSuffix("claude-opus-4-8"), "claude-opus-4-8");
	// A colon that is not a thinking level is preserved.
	assert.equal(stripThinkingSuffix("provider:model"), "provider:model");
});

test("extractThinkingSuffix returns the level only for a valid trailing suffix", () => {
	assert.equal(extractThinkingSuffix("model:high"), "high");
	assert.equal(extractThinkingSuffix("model:low"), "low");
	assert.equal(extractThinkingSuffix("model"), undefined);
	assert.equal(extractThinkingSuffix("provider/model"), undefined);
	assert.equal(extractThinkingSuffix("model:bogus"), undefined);
});

test("qualifyModel prefixes a bare model with the default provider only when needed", () => {
	assert.equal(qualifyModel("claude-opus-4-8", "anthropic"), "anthropic/claude-opus-4-8");
	assert.equal(qualifyModel("anthropic/claude-opus-4-8", "openai"), "anthropic/claude-opus-4-8");
	assert.equal(qualifyModel(undefined, "anthropic"), undefined);
	assert.equal(qualifyModel("claude-opus-4-8", undefined), "claude-opus-4-8");
	assert.equal(qualifyModel("", "anthropic"), "");
});

test("durable task framing preserves reads, final-answer and deliverables instructions", () => {
	const text = formatTaskMessage("Inspect the code.", {
		reads: ["README.md", "src/x.ts"],
		artifactsDir: "/night/worker.artifacts",
	});
	assert.match(text, /^Task:/);
	assert.match(text, /Read these files first for context: `README.md`, `src\/x.ts`/);
	assert.match(text, /Inspect the code/);
	assert.match(text, /final message/);
	assert.match(text, /Deliverables directory: `\/night\/worker.artifacts`/);
});
test("ordinary durable task framing does not invent read instructions", () => {
	assert.doesNotMatch(formatTaskMessage("Review", { reads: [] }), /Read these files first/);
});
