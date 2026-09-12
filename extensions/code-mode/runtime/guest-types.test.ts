import assert from "node:assert/strict";
import { test } from "node:test";

import { guestTypeDeclarations } from "./guest-types.ts";
import { typeCheckCodeModeCode } from "./type-checker.ts";

test("agents.models metadata type-checks in both code modes", () => {
	for (const full of [true, false]) {
		const checked = typeCheckCodeModeCode(
			"const catalog = await agents.models(); const id: string | null = catalog.defaultModel; return catalog.models.map(m => ({ id: m.id, images: m.input.includes('image'), reasoning: m.reasoning }));",
			guestTypeDeclarations(full),
		);
		assert.deepEqual(checked.errors, []);
	}
});

test("full code mode declares the tools discovery namespace", () => {
	const declarations = guestTypeDeclarations(true);
	assert.match(declarations, /declare const tools: CodeModeToolsApi;/);
	assert.match(declarations, /interface CodeModeToolsApi \{/);
	assert.match(declarations, /interface CodeModeCapabilityCatalog \{/);
	assert.match(declarations, /providers\(\): Promise<Array<\{ name: string; description: string \}>>;/);
	assert.match(declarations, /call\(args: \{ ref: string; args\?: Record<string, unknown> \}\): Promise<unknown>;/);
});

test("orchestration-only mode strips the tools global alongside pi and web", () => {
	const declarations = guestTypeDeclarations(false);
	assert.doesNotMatch(declarations, /declare const tools: CodeModeToolsApi;/);
	assert.doesNotMatch(declarations, /declare const pi: PiToolsApi;/);
	assert.doesNotMatch(declarations, /declare const extensions: CodeModeExtensionsApi;/);
	// the interface definitions remain harmlessly, only the globals are removed
	assert.match(declarations, /interface CodeModeToolsApi \{/);
});

test("declarations include the process shim and pi.bash extras", () => {
	const declarations = guestTypeDeclarations(true);
	assert.match(declarations, /declare const process: \{/);
	assert.match(declarations, /type CodeModeCommandOptions = \{/);
	assert.match(declarations, /stdin\?: string;/);
});

test("process stays available in orchestration-only mode", () => {
	const declarations = guestTypeDeclarations(false);
	assert.match(declarations, /declare const process: \{/);
});

test("guest code type-checks with process.env and pi.bash extras", () => {
	const checked = typeCheckCodeModeCode(
		"const home = process.env.HOME ?? '/';\n" +
			"const r = await pi.bash({ cmd: 'ls', cwd: home, env: { A: 'b' }, stdin: 'x', workdir: '/tmp', timeoutMs: 5000 });\n" +
			"return r;",
		guestTypeDeclarations(true),
	);
	assert.deepEqual(checked.errors, []);
});

test("guest code type-checks pi.applyPatch and its structured result", () => {
	const checked = typeCheckCodeModeCode(
		"const result = await pi.applyPatch({ patch: π.patch }); return result.details.changes[0]?.moveTo;",
		guestTypeDeclarations(true),
	);
	assert.deepEqual(checked.errors, []);
});

test("pi.applyPatch rejects unknown keys at the type level", () => {
	const declarations = guestTypeDeclarations(true);
	assert.ok(typeCheckCodeModeCode("await pi.applyPatch({ patch: 'x', path: 'y' });", declarations).errors.length > 0);
});

test("pi.bash extras reject unknown keys at the type level", () => {
	const checked = typeCheckCodeModeCode(
		"await pi.bash({ command: 'ls', workdirectory: '/tmp' });",
		guestTypeDeclarations(true),
	);
	assert.ok(checked.errors.length > 0);
});
