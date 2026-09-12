import assert from "node:assert/strict";
import { test } from "node:test";

import { GUEST_PROGRAM_FILE, mapGuestErrorText, MAPPED_PROGRAM_FILE, parseGuestSourceMap } from "./source-map.ts";
import { transpileSpindleCode } from "./type-checker.ts";

test("decodes a handcrafted map", () => {
	const map = parseGuestSourceMap(
		JSON.stringify({ version: 3, sources: ["a.ts"], names: [], mappings: "AAAA;AACA" }),
		{ headerLines: 0 },
	);
	assert.notEqual(map, undefined);
	assert.deepEqual(map!.originalPositionFor(1, 1), { line: 1, column: 1 });
	assert.deepEqual(map!.originalPositionFor(2, 1), { line: 2, column: 1 });
	assert.equal(map!.originalPositionFor(9, 1), undefined);
});

test("headerLines subtracts the wrapper line and clamps at the top", () => {
	const map = parseGuestSourceMap(
		JSON.stringify({ version: 3, sources: ["a.ts"], names: [], mappings: "AAAA;AACA" }),
		{ headerLines: 1 },
	);
	// Source line 1 is the wrapper header; it has no user-space position.
	assert.equal(map!.originalPositionFor(1, 1), undefined);
	assert.deepEqual(map!.originalPositionFor(2, 1), { line: 1, column: 1 });
});

test("a real transpile maps emitted positions back to the program", () => {
	const code = [
		"interface Shape { a: number }",
		"const g = (): void => {",
		"  throw new Error('marker');",
		"};",
		"return g();",
	].join("\n");
	const transpiled = transpileSpindleCode(code);
	assert.ok(transpiled.sourceMap !== undefined, "transpile must emit a source map");
	const map = parseGuestSourceMap(transpiled.sourceMap);
	assert.notEqual(map, undefined);

	const emittedLines = transpiled.javascript.split("\n");
	const emittedLine = emittedLines.findIndex((line) => line.includes("throw new Error('marker')"));
	assert.ok(emittedLine >= 0);
	const emittedColumn = emittedLines[emittedLine]!.indexOf("throw") + 1;
	const position = map!.originalPositionFor(emittedLine + 1, emittedColumn);
	assert.notEqual(position, undefined);
	// The interface line is type-only and disappears from the emit; the map
	// must still point the throw at program line 3.
	assert.equal(position!.line, 3);
	assert.ok(position!.column >= 1);
});

test("mapGuestErrorText rewrites mapped frames and leaves unmapped ones", () => {
	const code = "const g = (): void => {\n  throw new Error('marker');\n};\nreturn g();";
	const transpiled = transpileSpindleCode(code);
	const map = parseGuestSourceMap(transpiled.sourceMap);
	const emittedLines = transpiled.javascript.split("\n");
	const emittedIndex = emittedLines.findIndex((line) => line.includes("throw new Error"));
	const emittedLine = emittedIndex + 1;
	const emittedColumn = emittedLines[emittedIndex]!.indexOf("throw") + 1;
	const text = [
		`    at g (${GUEST_PROGRAM_FILE}:${emittedLine}:${emittedColumn})`,
		`    at <eval> (${GUEST_PROGRAM_FILE}:99:30)`,
	].join("\n");
	const mapped = mapGuestErrorText(text, map);
	assert.match(mapped, /program\.ts:2:\d+/);
	// A frame beyond the map stays untouched rather than guessing.
	assert.match(mapped, /pi-spindle-guest\.js:99:30/);
});

test("absent or malformed maps degrade to passthrough", () => {
	assert.equal(parseGuestSourceMap(undefined), undefined);
	assert.equal(parseGuestSourceMap(""), undefined);
	assert.equal(parseGuestSourceMap("not json"), undefined);
	assert.equal(parseGuestSourceMap(JSON.stringify({ mappings: 4 })), undefined);
	const text = `at g (${GUEST_PROGRAM_FILE}:2:3)`;
	assert.equal(mapGuestErrorText(text, undefined), text);
});
