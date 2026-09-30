import assert from "node:assert/strict";
import { test } from "node:test";
import { agentSandboxFloor } from "./agent-floor.ts";

test("agentSandboxFloor reads the parent's mode off argv", () => {
	assert.deepEqual(agentSandboxFloor(["pi", "--code-mode-sandbox", "read-only"]), { mode: "read-only" });
	assert.deepEqual(agentSandboxFloor(["pi", "--code-mode-sandbox=workspace-write"]), { mode: "workspace-write" });
});

test("agentSandboxFloor is undefined for a normal session", () => {
	assert.equal(agentSandboxFloor(["pi", "--session", "/tmp/s.jsonl"]), undefined);
});

test("agentSandboxFloor ignores an unrecognised mode instead of failing the child", () => {
	assert.equal(agentSandboxFloor(["pi", "--code-mode-sandbox", "readonly"]), undefined);
	assert.equal(agentSandboxFloor(["pi", "--code-mode-sandbox", ""]), undefined);
});
