import assert from "node:assert/strict";
import { test } from "node:test";

import {
  codeUsesOrchestration,
  isBlockingHostTimeoutRef,
  isBlockingOrchestrationRef,
  requestedBlockingTimeoutMs,
} from "./orchestration.ts";

test("blocking agent refs are detected", () => {
  assert.equal(isBlockingOrchestrationRef("agents.run"), true);
  assert.equal(isBlockingOrchestrationRef("agents.runAll"), true);
  assert.equal(isBlockingOrchestrationRef("pi.bash"), false);
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
  assert.equal(
    requestedBlockingTimeoutMs("pi.bash", { timeoutMs: 300_000, timeout: 1 }),
    300_000,
  );
});

test("missing or invalid timeouts request nothing", () => {
  assert.equal(requestedBlockingTimeoutMs("pi.bash", {}), 0);
  assert.equal(requestedBlockingTimeoutMs("pi.bash", { timeout: "600" }), 0);
  assert.equal(requestedBlockingTimeoutMs("pi.bash", { timeout: Number.NaN }), 0);
  assert.equal(requestedBlockingTimeoutMs("pi.read", { timeout: 600 }), 0);
});

test("agents.run still reports its millisecond timeout", () => {
  assert.equal(requestedBlockingTimeoutMs("agents.run", { timeoutMs: 5_000 }), 5_000);
  assert.equal(requestedBlockingTimeoutMs("agents.runAll", { timeoutMs: 5_000 }), 0);
});

test("static orchestration detection only matches agent call sites", () => {
  assert.equal(codeUsesOrchestration("await agents.run({ agent: 'x' })"), true);
  assert.equal(codeUsesOrchestration("await pi.bash({ cmd: 'x', timeout: 600 })"), false);
});
