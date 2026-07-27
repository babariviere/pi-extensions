import assert from "node:assert/strict";
import { test } from "node:test";

import { guestTypeDeclarations } from "../runtime/guest-types.ts";
import { isToolAllowed, parseToolAllowlist, toolRestrictionError } from "./tool-allowlist.ts";

test("parseToolAllowlist treats an absent or blank flag as unrestricted", () => {
  assert.equal(parseToolAllowlist(undefined), undefined);
  assert.equal(parseToolAllowlist(""), undefined);
  assert.equal(parseToolAllowlist("   "), undefined);
  assert.equal(parseToolAllowlist(true), undefined);
});

test("parseToolAllowlist splits, trims and drops the transport tools", () => {
  const allowlist = parseToolAllowlist(" read , grep ,spindle_exec,submit_result, ");
  assert.deepEqual([...allowlist!].sort(), ["grep", "read"]);
});

test("parseToolAllowlist yields an empty set when only transport tools are declared", () => {
  const allowlist = parseToolAllowlist("submit_result");
  assert.deepEqual([...allowlist!], []);
});

test("isToolAllowed defaults to allow when there is no allowlist", () => {
  assert.equal(isToolAllowed(undefined, "bash"), true);
  assert.equal(isToolAllowed(new Set(["read"]), "read"), true);
  assert.equal(isToolAllowed(new Set(["read"]), "bash"), false);
});

test("toolRestrictionError names the tool and the allowed set", () => {
  const message = toolRestrictionError("pi.bash", new Set(["read", "grep"])).message;
  assert.match(message, /pi\.bash/);
  assert.match(message, /grep, read/);
});

test("guestTypeDeclarations keeps every pi tool when unrestricted", () => {
  const declarations = guestTypeDeclarations(true);
  for (const name of ["read", "bash", "edit", "write", "grep", "find", "ls"]) {
    assert.ok(declarations.includes(`\n  ${name}(`), `expected ${name} in PiToolsApi`);
  }
});

test("guestTypeDeclarations removes disallowed pi tools from PiToolsApi", () => {
  const declarations = guestTypeDeclarations(true, new Set(["read", "grep"]));
  assert.ok(declarations.includes("\n  read("));
  assert.ok(declarations.includes("\n  grep("));
  for (const name of ["bash", "edit", "write", "find", "ls"]) {
    assert.ok(!declarations.includes(`\n  ${name}(`), `expected ${name} to be removed`);
  }
  // Only PiToolsApi is filtered; the other namespaces are untouched.
  assert.ok(declarations.includes("declare const pi: PiToolsApi;"));
  assert.ok(declarations.includes("declare const agents: SpindleAgentsApi;"));
  assert.ok(declarations.includes("declare const mcp: SpindleMcpApi;"));
});

test("guestTypeDeclarations drops the pi global when no core tool is allowed", () => {
  const declarations = guestTypeDeclarations(true, new Set(["some_extension_tool"]));
  assert.ok(!declarations.includes("declare const pi: PiToolsApi;"));
  assert.ok(declarations.includes("declare const extensions: SpindleExtensionsApi;"));
});

test("guestTypeDeclarations still drops pi and extensions outside full code mode", () => {
  const declarations = guestTypeDeclarations(false, new Set(["read"]));
  assert.ok(!declarations.includes("declare const pi: PiToolsApi;"));
  assert.ok(!declarations.includes("declare const extensions: SpindleExtensionsApi;"));
});
