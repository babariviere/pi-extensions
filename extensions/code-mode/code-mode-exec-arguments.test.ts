import assert from "node:assert/strict";
import { test } from "node:test";

import { prepareCodeModeExecArguments, resolveCodeModeExecPayloads } from "./code-mode-arguments.ts";
import { repairCodeModeGuestCode } from "./runtime/guest-code-repair.ts";

test("a code array joins into one program", () => {
	const prepared = prepareCodeModeExecArguments({ code: ["const a = 1;", "return a;"] }) as { code: string };
	assert.equal(prepared.code, "const a = 1;\nreturn a;");
});

test("a JSON-encoded payload map parses back to a record", () => {
	const prepared = prepareCodeModeExecArguments({
		code: "return 1;",
		payloads: JSON.stringify({ body: "line\nline" }),
	}) as { payloads: Record<string, string> };
	assert.deepEqual(prepared.payloads, { body: "line\nline" });
});

test("the legacy strings alias is remapped to payloads", () => {
	const prepared = prepareCodeModeExecArguments({ code: "return 1;", strings: { body: "x" } }) as Record<
		string,
		unknown
	>;
	assert.deepEqual(prepared.payloads, { body: "x" });
	assert.equal(Object.hasOwn(prepared, "strings"), false);
});

test("a double-encoded payload map parses back to a record", () => {
	const prepared = prepareCodeModeExecArguments({
		code: "return 1;",
		payloads: JSON.stringify(JSON.stringify({ body: "x" })),
	}) as { payloads: Record<string, string> };
	assert.deepEqual(prepared.payloads, { body: "x" });
});

test("nullish optionals are dropped", () => {
	const prepared = prepareCodeModeExecArguments({ code: "return 1;", payloads: null, display: null }) as Record<
		string,
		unknown
	>;
	assert.equal(Object.hasOwn(prepared, "payloads"), false);
	assert.equal(Object.hasOwn(prepared, "display"), false);
});

test("a bare display string normalizes to { name }", () => {
	const prepared = prepareCodeModeExecArguments({ code: "return 1;", display: "Read config" }) as {
		display: { name: string };
	};
	assert.deepEqual(prepared.display, { name: "Read config" });
});

test("unquoted paths and URLs are quoted before the type gate", () => {
	assert.equal(
		repairCodeModeGuestCode("return await pi.read(/tmp/foo.txt);"),
		'return await pi.read("/tmp/foo.txt");',
	);
	assert.equal(
		repairCodeModeGuestCode("return await pi.ls({ path: ./src });"),
		'return await pi.ls({ path: "./src" });',
	);
});

test("already quoted arguments are left alone", () => {
	const code = "return await pi.read('/tmp/foo.txt');";
	assert.equal(repairCodeModeGuestCode(code), code);
});

test("resolveCodeModeExecPayloads accepts records, JSON strings, and the alias", () => {
	assert.deepEqual(resolveCodeModeExecPayloads({ payloads: { a: "b" } }), { a: "b" });
	assert.deepEqual(resolveCodeModeExecPayloads({ payloads: '{"a":"b"}' }), { a: "b" });
	assert.deepEqual(resolveCodeModeExecPayloads({ strings: { a: "b" } }), { a: "b" });
	assert.equal(resolveCodeModeExecPayloads({ payloads: 42 }), undefined);
});
