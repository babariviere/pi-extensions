/** Durable worker inputs and result helpers. */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ResolvedOutput } from "./output.ts";
import { baseResult, runCwd, withChildConfigHome, type RunContext, type RunRequest } from "./run.ts";

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

test("a private child config home preserves the rest of the environment", () => {
	const env = withChildConfigHome("/tmp/child-xdg", { PATH: "/usr/bin", XDG_CONFIG_HOME: "/home/dev/.config" });
	assert.equal(env.XDG_CONFIG_HOME, "/tmp/child-xdg");
	assert.equal(env.PATH, "/usr/bin");
});

test("baseResult carries the failure class of a failed run", () => {
	const result = baseResult(request(), resolved(false), "durable worker never started", "launch");
	assert.equal(result.ok, false);
	assert.equal(result.failure, "launch");
	assert.equal(result.error, "durable worker never started");
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

test("runCwd uses the host workspace override and otherwise the parent cwd", () => {
	const req = request();
	const ctx = { cwd: "/parent" } as RunContext;
	assert.equal(runCwd(req, ctx), "/parent");
	assert.equal(runCwd({ ...req, cwd: "/workspace" }, ctx), "/workspace");
});
