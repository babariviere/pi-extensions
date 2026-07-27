import assert from "node:assert/strict";
import { test } from "node:test";

import { PI_CORE_TOOL_NAMES } from "../core/pi-tools.ts";
import { PiToolsProvider } from "./pi-tools-provider.ts";

const context = {} as any;
const listRequest = {} as any;

const provider = (allowed?: string[]) =>
  new PiToolsProvider(
    process.cwd(),
    undefined,
    undefined,
    allowed ? new Set(allowed) : undefined,
  );

const names = async (allowed?: string[]): Promise<string[]> =>
  (await provider(allowed).list(listRequest, context)).map((descriptor) => descriptor.name);

test("an unrestricted provider lists every pi core tool", async () => {
  assert.deepEqual((await names()).sort(), [...PI_CORE_TOOL_NAMES].sort());
});

test("list hides the tools a subagent's allowlist excludes", async () => {
  assert.deepEqual((await names(["read", "grep"])).sort(), ["grep", "read"]);
  assert.deepEqual(await names([]), []);
});

test("describe resolves an allowed tool", async () => {
  const descriptor = await provider(["read"]).describe("read", context);
  assert.equal(descriptor?.name, "read");
  assert.ok(descriptor?.inputSchema);
});

test("describe throws the restriction error for a disallowed tool", async () => {
  // ActionRegistry.invoke() resolves through describe(), so returning undefined
  // here would surface as "Unknown Spindle action" and read like a typo.
  await assert.rejects(
    () => provider(["read", "grep"]).describe("bash", context),
    /Tool pi\.bash is not in this agent's tool allowlist \(allowed: grep, read\)/,
  );
});

test("describe still returns undefined for a tool that does not exist", async () => {
  assert.equal(await provider(["read"]).describe("nope", context), undefined);
  assert.equal(await provider().describe("nope", context), undefined);
});

test("invoke rejects a disallowed tool before running it", async () => {
  await assert.rejects(
    () => provider(["read"]).invoke("bash", { command: "echo unreachable" }, context),
    /not in this agent's tool allowlist/,
  );
});

test("invoke still reports an unknown tool as unknown", async () => {
  await assert.rejects(() => provider(["read"]).invoke("nope", {}, context), /Unknown Pi tool: nope/);
});

test("prepareArguments rejects a disallowed tool", () => {
  assert.throws(
    () => provider(["read"]).prepareArguments("bash", { command: "echo unreachable" }),
    /not in this agent's tool allowlist/,
  );
});

test("an unrestricted provider gates nothing", async () => {
  const unrestricted = provider();
  assert.equal((await unrestricted.describe("bash", context))?.name, "bash");
  assert.doesNotThrow(() => unrestricted.prepareArguments("bash", { command: "true" }));
});
