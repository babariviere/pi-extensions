import assert from "node:assert/strict";
import { test } from "node:test";

import {
	activeCheckerBackend,
	checkerBackendName,
	installCheckerBackend,
	type CodeModeCheckerBackend,
	type CodeModeTypeCheckOutcome,
	type CodeModeTranspileResult,
} from "./checker-backend.ts";
import { transpileCodeModeCode, typeCheckCodeModeCode, typescriptCheckerBackend } from "./type-checker.ts";
import { guestTypeDeclarations } from "./guest-types.ts";

const declarations = guestTypeDeclarations(true);

test("the default backend is the stock typescript compiler", () => {
	assert.equal(checkerBackendName(), "typescript");
	assert.equal(activeCheckerBackend(), typescriptCheckerBackend);
});

test("the typescript backend reports positioned errors and emits a map", () => {
	const checked: CodeModeTypeCheckOutcome = typeCheckCodeModeCode("return missing_identifier;", declarations);
	assert.equal(checked.errors.length, 1);
	assert.equal(checked.errors[0]!.line, 1);
	assert.match(checked.errors[0]!.message, /missing_identifier/);
	assert.equal(checked.javascript, undefined, "no emit on errors");

	const clean = typeCheckCodeModeCode("return 1;", declarations);
	assert.deepEqual(clean.errors, []);
	assert.ok(clean.javascript?.includes("__piCodeModeMain"));
	assert.ok(clean.sourceMap?.includes("mappings"));
});

test("transpile returns JavaScript plus its source map", () => {
	const transpiled: CodeModeTranspileResult = transpileCodeModeCode("return 'x';");
	assert.ok(transpiled.javascript.includes("__piCodeModeMain"));
	assert.ok(transpiled.sourceMap !== undefined);
	JSON.parse(transpiled.sourceMap!);
});

test("an installed backend takes over both entry points", () => {
	const calls: string[] = [];
	const fake: CodeModeCheckerBackend = {
		name: "fake",
		check: (code) => {
			calls.push(`check:${code}`);
			return { errors: [] };
		},
		transpile: (code) => {
			calls.push(`transpile:${code}`);
			return { javascript: `/* fake */${code}` };
		},
	};
	installCheckerBackend(fake);
	try {
		assert.equal(checkerBackendName(), "fake");
		const checked = typeCheckCodeModeCode("return 1;", declarations);
		assert.deepEqual(checked, { errors: [] });
		const transpiled = transpileCodeModeCode("return 1;");
		assert.equal(transpiled.javascript, "/* fake */return 1;");
		assert.deepEqual(calls, ["check:return 1;", "transpile:return 1;"]);
	} finally {
		installCheckerBackend(undefined);
	}
	assert.equal(checkerBackendName(), "typescript");
});
