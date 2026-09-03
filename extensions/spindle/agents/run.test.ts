/**
 * `baseResult` is the one place both adapters assemble a result, so the rules
 * about failure classification are checked here rather than through a spawn.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ResolvedOutput } from "./output.ts";
import { baseResult, type RunRequest } from "./run.ts";

const request = (): RunRequest => ({
	agent: {
		scope: "user",
		config: { name: "task", body: "" },
	} as unknown as RunRequest["agent"],
	task: "do a thing",
	index: 0,
});

const resolved = (ok: boolean, extra: Partial<ResolvedOutput> = {}): ResolvedOutput => ({
	ok,
	output: ok ? "done" : "(no output produced)",
	...extra,
});

test("baseResult carries the failure class of a failed run", () => {
	const result = baseResult(request(), resolved(false), "herdr never confirmed the child", "launch");
	assert.equal(result.ok, false);
	assert.equal(result.failure, "launch");
	assert.equal(result.error, "herdr never confirmed the child");
});

test("baseResult leaves no failure class on a run that produced its output", () => {
	// A tolerated launch anomaly is not a failure once the child delivered.
	const result = baseResult(request(), resolved(true), undefined, "launch");
	assert.equal(result.ok, true);
	assert.equal(result.failure, undefined);
});

test("baseResult folds a write error into the reason without losing the class", () => {
	const result = baseResult(request(), resolved(false, { writeError: "EACCES" }), "timed out", "timeout");
	assert.equal(result.failure, "timeout");
	assert.match(result.error ?? "", /timed out; EACCES/);
});
