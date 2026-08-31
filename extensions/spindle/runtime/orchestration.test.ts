import assert from "node:assert/strict";
import { test } from "node:test";

import {
	codeUsesOrchestration,
	isAgentBudgetRef,
	isBlockingHostTimeoutRef,
	isBlockingOrchestrationRef,
	requestedBlockingTimeoutMs,
} from "./orchestration.ts";

test("blocking agent refs are detected", () => {
	assert.equal(isBlockingOrchestrationRef("agents.run"), true);
	assert.equal(isBlockingOrchestrationRef("agents.runAll"), true);
	assert.equal(isBlockingOrchestrationRef("agents.wait"), true);
	assert.equal(isBlockingOrchestrationRef("agents.start"), false);
	assert.equal(isBlockingOrchestrationRef("pi.bash"), false);
});

test("only the launching refs consume the agent budget", () => {
	assert.equal(isAgentBudgetRef("agents.run"), true);
	assert.equal(isAgentBudgetRef("agents.runAll"), true);
	assert.equal(isAgentBudgetRef("agents.start"), true);
	assert.equal(isAgentBudgetRef("agents.wait"), false);
	assert.equal(isAgentBudgetRef("agents.cancel"), false);
	assert.equal(isAgentBudgetRef("agents.status"), false);
});

test("pi.bash is a blocking host timeout ref", () => {
	assert.equal(isBlockingHostTimeoutRef("pi.bash"), true);
	assert.equal(isBlockingHostTimeoutRef("pi.read"), false);
	assert.equal(isBlockingHostTimeoutRef("agents.run"), false);
});

test("bash timeout is read in seconds and converted to milliseconds", () => {
	assert.equal(requestedBlockingTimeoutMs("pi.bash", { timeout: 600 }), 600_000);
});

test("bash timeoutMs wins when the guest proxy did not convert it", () => {
	assert.equal(requestedBlockingTimeoutMs("pi.bash", { timeoutMs: 300_000, timeout: 1 }), 300_000);
});

test("missing or invalid timeouts request nothing", () => {
	assert.equal(requestedBlockingTimeoutMs("pi.bash", {}), 0);
	assert.equal(requestedBlockingTimeoutMs("pi.bash", { timeout: "600" }), 0);
	assert.equal(requestedBlockingTimeoutMs("pi.bash", { timeout: Number.NaN }), 0);
	assert.equal(requestedBlockingTimeoutMs("pi.read", { timeout: 600 }), 0);
});

test("blocking agent refs report the longer of their wait window and child cap", () => {
	assert.equal(requestedBlockingTimeoutMs("agents.run", { timeoutMs: 5_000 }), 5_000);
	assert.equal(requestedBlockingTimeoutMs("agents.runAll", { timeoutMs: 5_000 }), 5_000);
	assert.equal(requestedBlockingTimeoutMs("agents.run", { waitMs: 9_000, timeoutMs: 5_000 }), 9_000);
	assert.equal(requestedBlockingTimeoutMs("agents.wait", { waitMs: 7_000 }), 7_000);
	assert.equal(requestedBlockingTimeoutMs("agents.start", { timeoutMs: 5_000 }), 0);
});

test("agents.wait is a call site the static detector recognizes", () => {
	assert.equal(codeUsesOrchestration("const r = await agents.wait({ runId })"), true);
	assert.equal(codeUsesOrchestration("await agents.status()"), false);
});

test("static orchestration detection only matches agent call sites", () => {
	assert.equal(codeUsesOrchestration("await agents.run({ agent: 'x' })"), true);
	assert.equal(codeUsesOrchestration("await pi.bash({ cmd: 'x', timeout: 600 })"), false);
});
