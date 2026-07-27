import assert from "node:assert/strict";
import { test } from "node:test";

import type { CapturedToolCatalog, CapturedToolEntry } from "../capture/catalog.ts";
import { CapturedToolsProvider } from "./captured-tools-provider.ts";

const context = {} as any;
const listRequest = {} as any;

const entry = (name: string): CapturedToolEntry =>
  ({
    name,
    definition: { name, description: `${name} tool`, parameters: { type: "object" } },
    sourceInfo: { path: `/ext/${name}.ts`, source: "cli", scope: "user", origin: "top-level" },
    risk: "execute",
  }) as unknown as CapturedToolEntry;

/** Only list/get/require are exercised by the provider. */
const catalog = (...entries: CapturedToolEntry[]): CapturedToolCatalog =>
  ({
    list: () => entries,
    get: (name: string) => entries.find((candidate) => candidate.name === name),
    require: (name: string) => {
      const found = entries.find((candidate) => candidate.name === name);
      if (!found) throw new Error(`Unknown captured extension tool: ${name}`);
      return found;
    },
  }) as unknown as CapturedToolCatalog;

const tools = catalog(entry("submit_result"), entry("todo"), entry("web_search"));

const provider = (allowed?: string[]) =>
  new CapturedToolsProvider(tools, allowed ? new Set(allowed) : undefined);

const names = async (allowed?: string[]): Promise<string[]> =>
  (await provider(allowed).list(listRequest, context)).map((descriptor) => descriptor.name);

test("an unrestricted provider lists every captured tool", async () => {
  assert.deepEqual((await names()).sort(), ["submit_result", "todo", "web_search"]);
});

test("list hides captured tools the allowlist excludes", async () => {
  // submit_result survives: it is transport, not a capability.
  assert.deepEqual((await names(["todo"])).sort(), ["submit_result", "todo"]);
});

test("submit_result stays reachable under any allowlist", async () => {
  // In full code mode it is captured and hidden, so extensions.submit_result is
  // a restricted subagent's only channel back to the caller.
  for (const allowed of [["read"], []]) {
    const restricted = provider(allowed);
    assert.equal((await restricted.describe("submit_result", context))?.name, "submit_result");
    assert.deepEqual(await names(allowed), ["submit_result"]);
  }
});

test("describe throws the restriction error for a disallowed captured tool", async () => {
  await assert.rejects(
    () => provider(["todo"]).describe("web_search", context),
    /Tool extensions\.web_search is not in this agent's tool allowlist \(allowed: todo\)/,
  );
});

test("describe still returns undefined for a tool that was never captured", async () => {
  assert.equal(await provider(["todo"]).describe("nope", context), undefined);
  assert.equal(await provider().describe("nope", context), undefined);
});

test("invoke and prepareArguments reject a disallowed captured tool", async () => {
  await assert.rejects(
    () => provider(["todo"]).invoke("web_search", {}, context),
    /not in this agent's tool allowlist/,
  );
  assert.throws(
    () => provider(["todo"]).prepareArguments("web_search", {}),
    /not in this agent's tool allowlist/,
  );
});
