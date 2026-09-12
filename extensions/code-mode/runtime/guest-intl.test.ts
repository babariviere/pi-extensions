import assert from "node:assert/strict";
import { test } from "node:test";

import { QuickJsRuntime } from "./quickjs-runtime.ts";

const baseOptions = {
	timeoutMs: 10_000,
	memoryLimitBytes: 32 * 1024 * 1024,
};

const unexpectedHostCall = async () => {
	throw new Error("unexpected host call");
};

const run = async (code: string): Promise<unknown> => {
	const runtime = new QuickJsRuntime();
	const result = await runtime.execute(code, unexpectedHostCall, baseOptions);
	assert.equal(result.terminationReason, "completed", result.error ?? "");
	return result.value;
};

test("Intl reports itself as unavailable instead of being undefined", async () => {
	const message = await run(
		"try { new Intl.NumberFormat('de-DE').format(1); return 'no throw'; } catch (error) { return error.name + ': ' + error.message; }",
	);
	assert.match(String(message), /^NotSupportedError: Intl\.NumberFormat is not available/);
	assert.match(String(message), /without ICU/);
	assert.match(String(message), /let the host format it/);
});

test("Atomics reports itself as unavailable", async () => {
	const message = await run(
		"try { Atomics.add(new Int32Array(1), 0, 1); return 'no throw'; } catch (error) { return error.message; }",
	);
	assert.match(String(message), /Atomics\.add is not available/);
	assert.match(String(message), /single-threaded/);
});

test("a locale argument throws rather than being ignored", async () => {
	// The engine implements these and silently drops the locale, so the old
	// behaviour was a wrong answer that looked right: "1234.5", not "1.234,5".
	const cases = [
		"(1234.5).toLocaleString('de-DE')",
		"(10n).toLocaleString('de-DE')",
		"new Date(0).toLocaleString('de-DE')",
		"new Date(0).toLocaleDateString('de-DE')",
		"new Date(0).toLocaleTimeString('de-DE')",
		"'i'.toLocaleUpperCase('tr')",
		"[1234.5].toLocaleString('de-DE')",
	];
	for (const expression of cases) {
		const message = await run(`try { ${expression}; return 'no throw'; } catch (error) { return error.message; }`);
		assert.match(String(message), /with a locale is not available/, expression);
		assert.match(String(message), /the locale argument is ignored/, expression);
	}
});

test("the same methods still work without a locale", async () => {
	const value = await run(
		[
			"return [",
			"  (1234.5).toLocaleString(),",
			"  (10n).toLocaleString(),",
			"  'I'.toLocaleLowerCase(),",
			"  [1, 2].toLocaleString(),",
			"  typeof new Date(0).toLocaleString(),",
			"];",
		].join("\n"),
	);
	assert.deepEqual(value, ["1234.5", "10", "i", "1,2", "string"]);
});

test("an explicit undefined locale is still allowed", async () => {
	assert.equal(await run("return (1234.5).toLocaleString(undefined);"), "1234.5");
});

test("a program that never mentions locales is untouched", async () => {
	// The guard is trigger-injected, so it must not be present otherwise.
	const value = await run("return [typeof globalThis['Int' + 'l'], typeof globalThis['Atom' + 'ics']];");
	assert.deepEqual(value, ["undefined", "undefined"]);
});
