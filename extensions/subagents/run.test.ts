import assert from "node:assert/strict";
import { test } from "node:test";
import { withChildConfigHome } from "./run.ts";

test("a private child config home preserves the rest of the environment", () => {
	const env = withChildConfigHome("/tmp/child-xdg", { PATH: "/usr/bin", XDG_CONFIG_HOME: "/home/dev/.config" });
	assert.equal(env.XDG_CONFIG_HOME, "/tmp/child-xdg");
	assert.equal(env.PATH, "/usr/bin");
});
