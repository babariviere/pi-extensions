import assert from "node:assert/strict";
import { test } from "node:test";

import { QuickJsRuntime } from "./quickjs-runtime.ts";

const unexpectedHostCall = async () => {
  throw new Error("unexpected host call");
};

test("process exposes the injected allowlisted snapshot", async () => {
  const runtime = new QuickJsRuntime();
  const result = await runtime.execute(
    "return [process.env.HOME, process.platform, process.arch, process.cwd(), Object.isFrozen(process.env), Object.isFrozen(process)].join('|');",
    unexpectedHostCall,
    {
      timeoutMs: 10_000,
      memoryLimitBytes: 32 * 1024 * 1024,
      process: { env: { HOME: "/home/test" }, platform: "linux", arch: "x64", cwd: "/session" },
    },
  );
  assert.equal(result.terminationReason, "completed");
  assert.equal(
    result.value,
    "/home/test|linux|x64|/session|true|true",
  );
});

test("process falls back to an empty shim when nothing is injected", async () => {
  const runtime = new QuickJsRuntime();
  const result = await runtime.execute(
    "return [JSON.stringify(process.env), process.platform, process.cwd()].join('|');",
    unexpectedHostCall,
    { timeoutMs: 10_000, memoryLimitBytes: 32 * 1024 * 1024 },
  );
  assert.equal(result.terminationReason, "completed");
  assert.equal(result.value, "{}|unknown|");
});
