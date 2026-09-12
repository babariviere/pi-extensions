import assert from "node:assert/strict";
import { test } from "node:test";
import type { Model } from "@earendil-works/pi-ai";

import { subagentModelPriceError } from "./model-policy.ts";

function model(id: string, input: number, output: number): Model<any> {
	return { id, provider: "test", cost: { input, output } } as Model<any>;
}

const catalog = [
	model("claude-opus-5", 10, 20),
	model("gpt-5.6-sol", 15, 10),
	model("cheap", 5, 5),
	model("expensive", 20, 20),
];

test("permits a model at or below the approved price ceiling", () => {
	assert.equal(subagentModelPriceError("cheap", catalog, undefined), undefined);
	assert.equal(subagentModelPriceError("gpt-5.6-sol", catalog, undefined), undefined);
});

test("rejects a model above the approved price ceiling", () => {
	assert.match(subagentModelPriceError("expensive", catalog, undefined) ?? "", /exceeds the subagent price ceiling/);
});

test("rejects unknown and unpriced models", () => {
	assert.match(subagentModelPriceError("missing", catalog, undefined) ?? "", /unavailable or has no pricing/);
});

test("fails closed when no subagent model is resolved", () => {
	assert.match(subagentModelPriceError(undefined, catalog, undefined) ?? "", /price ceiling cannot be enforced/);
});

test("fails closed when a reference price is unavailable", () => {
	assert.match(
		subagentModelPriceError("cheap", catalog.slice(1), undefined) ?? "",
		/Cannot enforce the subagent price ceiling/,
	);
});
