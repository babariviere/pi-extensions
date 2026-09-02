import assert from "node:assert/strict";
import { test } from "node:test";

import { guestTypeDeclarations } from "../runtime/guest-types.ts";
import { parseToolAllowlist, SpindleToolGate } from "./tool-allowlist.ts";

test("parseToolAllowlist treats an absent or blank flag as unrestricted", () => {
	assert.equal(parseToolAllowlist(undefined), undefined);
	assert.equal(parseToolAllowlist(""), undefined);
	assert.equal(parseToolAllowlist("   "), undefined);
	assert.equal(parseToolAllowlist(true), undefined);
});

test("parseToolAllowlist splits, trims and drops the transport tool", () => {
	const allowlist = parseToolAllowlist(" read , grep ,spindle_exec, ");
	assert.deepEqual([...allowlist!].sort(), ["grep", "read"]);
});

test("parseToolAllowlist yields an empty set when only the transport tool is declared", () => {
	const allowlist = parseToolAllowlist("spindle_exec");
	assert.deepEqual([...allowlist!], []);
});

test("an unrestricted gate allows everything and never throws", () => {
	const gate = SpindleToolGate.of(undefined);
	assert.equal(gate.restricted, false);
	assert.equal(gate.allows("bash"), true);
	assert.doesNotThrow(() => gate.assert("pi", "bash"));
});

test("a restricted gate allows only its members", () => {
	const gate = SpindleToolGate.of(new Set(["read"]));
	assert.equal(gate.restricted, true);
	assert.equal(gate.allows("read"), true);
	assert.equal(gate.allows("bash"), false);
});

test("a gate always permits the transport tool", () => {
	// spindle_exec is the child's only tool path in full code mode; it is never
	// callable from inside the sandbox, so the gate must never reject it.
	assert.equal(SpindleToolGate.of(new Set(["read"])).allows("spindle_exec"), true);
	assert.equal(SpindleToolGate.of(new Set<string>()).allows("spindle_exec"), true);
});

test("assert names the namespaced tool and the allowed set", () => {
	const gate = SpindleToolGate.of(new Set(["read", "grep"]));
	assert.throws(
		() => gate.assert("pi", "bash"),
		(error: Error) => {
			assert.match(error.message, /pi\.bash/);
			assert.match(error.message, /grep, read/);
			return true;
		},
	);
});

test("guestTypeDeclarations keeps every pi tool when unrestricted", () => {
	const declarations = guestTypeDeclarations(true);
	for (const name of ["read", "bash", "edit", "write", "grep", "find", "ls"]) {
		assert.ok(declarations.includes(`\n  ${name}(`), `expected ${name} in PiToolsApi`);
	}
});

test("guestTypeDeclarations removes disallowed pi tools from PiToolsApi", () => {
	const declarations = guestTypeDeclarations(true, SpindleToolGate.of(new Set(["read", "grep"])));
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
	const declarations = guestTypeDeclarations(true, SpindleToolGate.of(new Set(["some_extension_tool"])));
	assert.ok(!declarations.includes("declare const pi: PiToolsApi;"));
	assert.ok(declarations.includes("declare const extensions: SpindleExtensionsApi;"));
});

test("guestTypeDeclarations still drops pi and extensions outside full code mode", () => {
	const declarations = guestTypeDeclarations(false, SpindleToolGate.of(new Set(["read"])));
	assert.ok(!declarations.includes("declare const pi: PiToolsApi;"));
	assert.ok(!declarations.includes("declare const extensions: SpindleExtensionsApi;"));
});
