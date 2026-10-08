import assert from "node:assert/strict";
import { test } from "node:test";
import { builtinAgent } from "./discovery.ts";
import { runCwd, withChildConfigHome, type RunContext, type RunRequest } from "./run.ts";

test("a private child config home preserves the rest of the environment", () => {
	const env = withChildConfigHome("/tmp/child-xdg", { PATH: "/usr/bin", XDG_CONFIG_HOME: "/home/dev/.config" });
	assert.equal(env.XDG_CONFIG_HOME, "/tmp/child-xdg");
	assert.equal(env.PATH, "/usr/bin");
});
test("runCwd uses the pinned conversation directory unless the host overrides it with a workspace", () => {
	const request: RunRequest = { agent: builtinAgent(), task: "work", index: 0 };
	const context = { cwd: "/parent" } as RunContext;
	assert.equal(runCwd(request, context), "/parent");
	assert.equal(runCwd({ ...request, cwd: "/workspace" }, context), "/workspace");
});
