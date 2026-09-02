import assert from "node:assert/strict";
import { test } from "node:test";

import { prepareSpindleExecArguments, resolveSpindleExecStrings } from "./spindle-exec-arguments.ts";
import { repairSpindleGuestCode } from "./runtime/guest-code-repair.ts";

test("a code array joins into one program", () => {
	const prepared = prepareSpindleExecArguments({ code: ["const a = 1;", "return a;"] }) as { code: string };
	assert.equal(prepared.code, "const a = 1;\nreturn a;");
});

test("a JSON-encoded strings map parses back to a record", () => {
	const prepared = prepareSpindleExecArguments({
		code: "return 1;",
		strings: JSON.stringify({ body: "line\nline" }),
	}) as { strings: Record<string, string> };
	assert.deepEqual(prepared.strings, { body: "line\nline" });
});

test("a double-encoded strings map parses back to a record", () => {
	const prepared = prepareSpindleExecArguments({
		code: "return 1;",
		strings: JSON.stringify(JSON.stringify({ body: "x" })),
	}) as { strings: Record<string, string> };
	assert.deepEqual(prepared.strings, { body: "x" });
});

test("nullish optionals are dropped", () => {
	const prepared = prepareSpindleExecArguments({ code: "return 1;", strings: null, display: null }) as Record<
		string,
		unknown
	>;
	assert.equal(Object.hasOwn(prepared, "strings"), false);
	assert.equal(Object.hasOwn(prepared, "display"), false);
});

test("a bare display string normalizes to { name }", () => {
	const prepared = prepareSpindleExecArguments({ code: "return 1;", display: "Read config" }) as {
		display: { name: string };
	};
	assert.deepEqual(prepared.display, { name: "Read config" });
});

test("unquoted paths and URLs are quoted before the type gate", () => {
	assert.equal(repairSpindleGuestCode("return await pi.read(/tmp/foo.txt);"), 'return await pi.read("/tmp/foo.txt");');
	assert.equal(
		repairSpindleGuestCode("return await pi.ls({ path: ./src });"),
		'return await pi.ls({ path: "./src" });',
	);
});

test("already quoted arguments are left alone", () => {
	const code = "return await pi.read('/tmp/foo.txt');";
	assert.equal(repairSpindleGuestCode(code), code);
});

test("resolveSpindleExecStrings accepts records and JSON strings", () => {
	assert.deepEqual(resolveSpindleExecStrings({ strings: { a: "b" } }), { a: "b" });
	assert.deepEqual(resolveSpindleExecStrings({ strings: '{"a":"b"}' }), { a: "b" });
	assert.equal(resolveSpindleExecStrings({ strings: 42 }), undefined);
});
