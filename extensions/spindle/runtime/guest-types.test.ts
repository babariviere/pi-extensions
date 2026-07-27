import assert from "node:assert/strict";
import { test } from "node:test";

import { guestTypeDeclarations } from "./guest-types.ts";

test("full code mode declares the tools discovery namespace", () => {
  const declarations = guestTypeDeclarations(true);
  assert.match(declarations, /declare const tools: SpindleToolsApi;/);
  assert.match(declarations, /interface SpindleToolsApi \{/);
  assert.match(declarations, /interface SpindleCapabilityCatalog \{/);
  assert.match(declarations, /providers\(\): Promise<Array<\{ name: string; description: string \}>>;/);
  assert.match(declarations, /call\(args: \{ ref: string; args\?: Record<string, unknown> \}\): Promise<unknown>;/);
});

test("orchestration-only mode strips the tools global alongside pi and extensions", () => {
  const declarations = guestTypeDeclarations(false);
  assert.doesNotMatch(declarations, /declare const tools: SpindleToolsApi;/);
  assert.doesNotMatch(declarations, /declare const pi: PiToolsApi;/);
  assert.doesNotMatch(declarations, /declare const extensions: SpindleExtensionsApi;/);
  // the interface definitions remain harmlessly, only the globals are removed
  assert.match(declarations, /interface SpindleToolsApi \{/);
});
