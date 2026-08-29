import assert from "node:assert/strict";
import { test } from "node:test";

import { guestTypeDeclarations } from "./guest-types.ts";
import { typeCheckSpindleCode } from "./type-checker.ts";

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

test("declarations include the process shim and pi.bash extras", () => {
  const declarations = guestTypeDeclarations(true);
  assert.match(declarations, /declare const process: \{/);
  assert.match(declarations, /type SpindleBashOptions = \{/);
  assert.match(declarations, /stdin\?: string;/);
});

test("process stays available in orchestration-only mode", () => {
  const declarations = guestTypeDeclarations(false);
  assert.match(declarations, /declare const process: \{/);
});

test("guest code type-checks with process.env and pi.bash extras", () => {
  const checked = typeCheckSpindleCode(
    "const home = process.env.HOME ?? '/';\n" +
      "const r = await pi.bash({ cmd: 'ls', cwd: home, env: { A: 'b' }, stdin: 'x', workdir: '/tmp', timeoutMs: 5000 });\n" +
      "return r;",
    guestTypeDeclarations(true),
  );
  assert.deepEqual(checked.errors, []);
});

test("pi.bash extras reject unknown keys at the type level", () => {
  const checked = typeCheckSpindleCode(
    "await pi.bash({ command: 'ls', workdirectory: '/tmp' });",
    guestTypeDeclarations(true),
  );
  assert.ok(checked.errors.length > 0);
});
