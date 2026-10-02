import assert from "node:assert/strict";
import { test } from "node:test";
import { extractThinkingSuffix, qualifyModel, stripThinkingSuffix, THINKING_LEVELS } from "./pi-args.ts";

test("THINKING_LEVELS retains the supported levels in order", () => {
	assert.deepEqual(THINKING_LEVELS, ["off", "minimal", "low", "medium", "high", "xhigh"]);
});

test("thinking helpers recognize every supported trailing suffix", () => {
	for (const level of THINKING_LEVELS) {
		for (const model of ["model", "provider/model", "provider:model"]) {
			assert.equal(stripThinkingSuffix(`${model}:${level}`), model);
			assert.equal(extractThinkingSuffix(`${model}:${level}`), level);
		}
	}
});

test("thinking helpers preserve absent, unknown, case-mismatched and nontrailing suffixes", () => {
	for (const model of [
		"",
		"model",
		"provider/model",
		"provider:model",
		"model:bogus",
		"model:HIGH",
		"model:high:",
		"model:high/other",
	]) {
		assert.equal(stripThinkingSuffix(model), model);
		assert.equal(extractThinkingSuffix(model), undefined);
	}
});

test("thinking helpers inspect only the final colon, including an empty model prefix", () => {
	assert.equal(stripThinkingSuffix("model:low:high"), "model:low");
	assert.equal(extractThinkingSuffix("model:low:high"), "high");
	assert.equal(stripThinkingSuffix(":off"), "");
	assert.equal(extractThinkingSuffix(":off"), "off");
});

test("qualifyModel prefixes bare models without changing thinking suffixes", () => {
	assert.equal(qualifyModel("claude-opus-4-8", "anthropic"), "anthropic/claude-opus-4-8");
	assert.equal(qualifyModel("model:high", "provider"), "provider/model:high");
});

test("qualifyModel preserves qualified, absent and provider-less models", () => {
	assert.equal(qualifyModel("anthropic/claude-opus-4-8", "openai"), "anthropic/claude-opus-4-8");
	assert.equal(qualifyModel("provider/model:high", "other"), "provider/model:high");
	assert.equal(qualifyModel(undefined, "anthropic"), undefined);
	assert.equal(qualifyModel("", "anthropic"), "");
	assert.equal(qualifyModel("model", undefined), "model");
	assert.equal(qualifyModel("model", ""), "model");
});
