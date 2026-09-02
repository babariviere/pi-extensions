import assert from "node:assert/strict";
import { test } from "node:test";

import { actionArgNormalizer } from "./arg-normalization.ts";

const normalize = actionArgNormalizer(() => [
	{
		name: "run",
		inputSchema: {
			type: "object",
			properties: {
				agent: { type: "string" },
				task: { type: "string" },
				reads: { type: "array", items: { type: "string" } },
				waitMs: { type: "number" },
				mode: { type: "string", enum: ["headless", "pane"] },
			},
			required: ["task"],
			additionalProperties: false,
		},
	},
]);

test("a synonym key repairs to the single declared member", () => {
	assert.deepEqual(normalize("run", { prompt: "do it" }), { task: "do it" });
});

test("casing variants repair to the declared spelling", () => {
	assert.deepEqual(normalize("run", { wait_ms: 10 }), { waitMs: 10 });
});

test("a singular near-miss repairs to the declared plural", () => {
	assert.deepEqual(normalize("run", { task: "x", read: ["a"] }), { task: "x", reads: ["a"] });
});

test("the canonical key wins over a spelling variant", () => {
	assert.deepEqual(normalize("run", { task: "canonical", prompt: "variant" }), { task: "canonical" });
});

test("numeric strings coerce for declared numeric fields", () => {
	assert.deepEqual(normalize("run", { task: "x", waitMs: "2500" }), { task: "x", waitMs: 2500 });
});

test("enum value spellings repair to declared members", () => {
	assert.deepEqual(normalize("run", { task: "x", mode: "Headless" }), { task: "x", mode: "headless" });
});

test("nullish declared optionals are stripped", () => {
	assert.deepEqual(normalize("run", { task: "x", agent: null }), { task: "x" });
});

test("an undeclared action passes its arguments through", () => {
	assert.deepEqual(normalize("unknown", { prompt: "x" }), { prompt: "x" });
});
