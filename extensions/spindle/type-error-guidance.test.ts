import assert from "node:assert/strict";
import { test } from "node:test";

import { CORE_TOOL_NAMES, CORE_TOOL_PROPERTIES } from "./runtime/core-tool-properties.ts";
import { typeErrorRecoveryHint } from "./type-error-guidance.ts";

const error = (message: string, line = 1, column = 40) => ({ message, line, column });

test("core tool names and properties derive from the guest declarations", () => {
	assert.ok(CORE_TOOL_NAMES.includes("bash"));
	assert.ok(CORE_TOOL_NAMES.includes("read"));
	assert.deepEqual(CORE_TOOL_PROPERTIES.get("settle"), ["bash", "exec"]);
	assert.ok(CORE_TOOL_PROPERTIES.get("path")?.includes("read"));
});

test("a property owned by another tool names its owner", () => {
	const hint = typeErrorRecoveryHint("return await pi.read({ path: '/x', settle: true });", [
		error("'settle' does not exist in type '{ path: string }'"),
	]);
	assert.match(String(hint), /`settle` is not a `pi\.read` property/);
	assert.match(String(hint), /`pi\.bash`/);
});

test("a misplaced envelope argument points back at spindle_exec", () => {
	const hint = typeErrorRecoveryHint("return await pi.write({ path: '/x', strings: {} });", [
		error("'strings' does not exist in type '{ path: string }'"),
	]);
	assert.match(String(hint), /`strings` is a `spindle_exec` argument/);
});

test("unquoted paths are diagnosed", () => {
	const hint = typeErrorRecoveryHint("return await pi.read(/tmp/x);", [error("Cannot find name 'tmp'")]);
	assert.match(String(hint), /quote filesystem paths/);
});

test("a literal interpolation in a write payload is diagnosed", () => {
	const hint = typeErrorRecoveryHint("await pi.write({ path: '/x', content: `${body}` });", [
		error("Cannot find name 'body'"),
	]);
	assert.match(String(hint), /move the payload to top-level `strings`/);
});

test("a Promise.all arity mismatch is diagnosed", () => {
	const hint = typeErrorRecoveryHint("const [a, b] = await Promise.all([pi.read('/x')]);", [
		error("Tuple type '[string]' of length '1' has no element at index '1'"),
	]);
	assert.match(String(hint), /one binding per promise/);
});

test("unrecognized errors produce no hint", () => {
	assert.equal(typeErrorRecoveryHint("return 1;", [error("Something else")]), undefined);
});
