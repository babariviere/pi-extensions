import assert from "node:assert/strict";
import { test } from "node:test";

import { QuickJsRuntime } from "./quickjs-runtime.ts";

/**
 * Locks the guest engine baseline.
 *
 * The sandbox runs bellard/quickjs `2025-09-13+f1139494` (see
 * `@jitl/quickjs-singlefile-mjs-release-sync@0.32.0`, variant
 * `library: quickjs, releaseMode: release, syncMode: sync,
 * emscriptenInclusion: singlefile`). Nothing about that engine's global
 * surface is guaranteed by the package's semver, so a `quickjs-emscripten-core`
 * bump can silently add or remove intrinsics.
 *
 * These tests are the diff detector for such a bump, and the reference for
 * which APIs `runtime/guest-polyfills.ts` has to supply. When a version bump
 * makes one fail, decide deliberately whether to accept the new baseline
 * (update the list) or pin back, then keep `runtime/type-checker.ts`'s `lib`
 * and `runtime/guest-types.ts`'s declarations in step with it.
 */

const unexpectedHostCall = async () => {
	throw new Error("unexpected host call");
};

const baseOptions = {
	timeoutMs: 10_000,
	memoryLimitBytes: 32 * 1024 * 1024,
};

const probe = async (code: string): Promise<unknown> => {
	const runtime = new QuickJsRuntime();
	const result = await runtime.execute(code, unexpectedHostCall, baseOptions);
	assert.equal(result.terminationReason, "completed", result.error ?? "");
	return result.value;
};

/**
 * Everything `GUEST_SETUP` installs, plus the two names the runtime itself
 * needs in guest scope. Filtered out of the engine inventory below so this
 * test fails on an *engine* change, not on a deliberate change to the Spindle
 * surface (which `guest-host-refs.test.ts` and the type declarations cover).
 */
const SPINDLE_OWNED = new Set([
	"__piSpindleMain",
	"__spindleExecutionGate",
	"agents",
	"clearInterval",
	"clearTimeout",
	"console",
	"extensions",
	"mapLimit",
	"mcp",
	"pi",
	"print",
	"process",
	"setInterval",
	"setTimeout",
	"tools",
	"π",
	"τ",
]);

/** The engine's own `globalThis` inventory, as shipped by the pinned variant. */
const ENGINE_GLOBALS = [
	"AggregateError",
	"Array",
	"ArrayBuffer",
	"BigInt",
	"BigInt64Array",
	"BigUint64Array",
	"Boolean",
	"DataView",
	"Date",
	"Error",
	"EvalError",
	"FinalizationRegistry",
	"Float16Array",
	"Float32Array",
	"Float64Array",
	"Function",
	"Infinity",
	"Int16Array",
	"Int32Array",
	"Int8Array",
	"InternalError",
	"Iterator",
	"JSON",
	"Map",
	"Math",
	"NaN",
	"Number",
	"Object",
	"Promise",
	"Proxy",
	"RangeError",
	"ReferenceError",
	"Reflect",
	"RegExp",
	"Set",
	"SharedArrayBuffer",
	"String",
	"Symbol",
	"SyntaxError",
	"TypeError",
	"URIError",
	"Uint16Array",
	"Uint32Array",
	"Uint8Array",
	"Uint8ClampedArray",
	"WeakMap",
	"WeakRef",
	"WeakSet",
	"decodeURI",
	"decodeURIComponent",
	"encodeURI",
	"encodeURIComponent",
	"escape",
	"eval",
	"globalThis",
	"isFinite",
	"isNaN",
	"parseFloat",
	"parseInt",
	"undefined",
	"unescape",
];

test("the engine global inventory is the pinned baseline", async () => {
	const value = await probe("return Object.getOwnPropertyNames(globalThis).sort().join(',');");
	const observed = String(value)
		.split(",")
		.filter((name) => !SPINDLE_OWNED.has(name));
	assert.deepEqual(observed, ENGINE_GLOBALS);
});

/**
 * Language features the pinned engine implements past its declared
 * type-checker `lib`. These are the reason `runtime/type-checker.ts` carries a
 * hand-written ES2024/ES2025 supplement: the engine is ahead of `lib.es2023`,
 * and without the supplement they only work because TS2339 is filtered.
 */
const PRESENT: Array<[string, string]> = [
	["Object.groupBy", "typeof Object.groupBy"],
	["Map.groupBy", "typeof Map.groupBy"],
	["Promise.withResolvers", "typeof Promise.withResolvers"],
	["Set.prototype.union", "typeof new Set().union"],
	["Set.prototype.intersection", "typeof new Set().intersection"],
	["Set.prototype.difference", "typeof new Set().difference"],
	["Iterator.prototype.map", "typeof Iterator.prototype.map"],
	["RegExp.escape", "typeof RegExp.escape"],
	["Error.isError", "typeof Error.isError"],
	["Array.prototype.toSorted", "typeof [].toSorted"],
	["Array.prototype.with", "typeof [].with"],
	["Array.prototype.toSpliced", "typeof [].toSpliced"],
	["Array.prototype.findLast", "typeof [].findLast"],
	["Object.hasOwn", "typeof Object.hasOwn"],
	["String.prototype.replaceAll", "typeof ''.replaceAll"],
];

for (const [name, expression] of PRESENT) {
	test(`the engine implements ${name}`, async () => {
		assert.equal(await probe(`return ${expression};`), "function");
	});
}

test("the engine implements the ES2024 regexp flags", async () => {
	const value = await probe(
		"return [new RegExp('[\\\\p{L}]', 'v').test('a'), new RegExp('(?<=a)b').test('ab'), new RegExp('a', 'd').exec('a').indices !== undefined].join('|');",
	);
	assert.equal(value, "true|true|true");
});

/**
 * APIs the engine does not ship. Each entry is either supplied by
 * `runtime/guest-polyfills.ts` (and therefore asserted present by
 * `guest-polyfills.test.ts`) or a deliberate omission recorded here.
 *
 * `Intl` in particular is absent because bellard/quickjs ships no ICU
 * dependency (https://bellard.org/quickjs/), which is why the polyfill layer
 * removes the `toLocaleString` family rather than leaving it silently
 * locale-blind.
 */
const ABSENT_FROM_ENGINE = [
	"Intl",
	"TextEncoder",
	"TextDecoder",
	"URL",
	"URLSearchParams",
	"atob",
	"btoa",
	"crypto",
	"queueMicrotask",
	"performance",
	"structuredClone",
	"AbortController",
	"fetch",
	"Buffer",
	"ReadableStream",
	"WebAssembly",
	"Temporal",
];

test("the bare engine ships none of the host APIs Spindle polyfills", async () => {
	// polyfills: false keeps this a statement about the engine. The probe names
	// the polyfilled globals as literals, which would otherwise trigger the
	// text-scan injection in runtime/guest-polyfills.ts and install them.
	const runtime = new QuickJsRuntime();
	const result = await runtime.execute(
		`return ${JSON.stringify(ABSENT_FROM_ENGINE)}.filter((name) => typeof globalThis[name] !== "undefined");`,
		unexpectedHostCall,
		{ ...baseOptions, polyfills: false },
	);
	assert.equal(result.terminationReason, "completed", result.error ?? "");
	assert.deepEqual(result.value, []);
});

test("the engine ships no ES2024+ features Spindle must not promise", async () => {
	const value = await probe(
		"return ['Array.fromAsync', typeof Array.fromAsync, 'JSON.rawJSON', typeof JSON.rawJSON, 'Symbol.dispose', typeof Symbol.dispose].join('|');",
	);
	// The type-checker `lib` must stay at es2023 + an explicit supplement rather
	// than esnext, or these become runtime ReferenceErrors instead of type errors.
	assert.equal(value, "Array.fromAsync|undefined|JSON.rawJSON|undefined|Symbol.dispose|undefined");
});
