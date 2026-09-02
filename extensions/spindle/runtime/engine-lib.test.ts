import assert from "node:assert/strict";
import { test } from "node:test";

import { guestTypeDeclarations } from "./guest-types.ts";
import { typeCheckSpindleCode } from "./type-checker.ts";

/**
 * Guards the type-checker `lib` tier against the engine baseline pinned by
 * `guest-baseline.test.ts`.
 *
 * The discriminator these tests use is arity (TS2554), not
 * property-existence (TS2339). `TYPE_CORRECTNESS_CODES` in
 * `runtime/type-checker.ts` filters TS2339/TS2551 out of the reported
 * diagnostics, so an API missing from `lib` does not raise an error, it just
 * resolves to `any`. Calling with the wrong number of arguments is therefore
 * the cheapest observable proof that a real signature is loaded.
 */

const declarations = guestTypeDeclarations(true);

const check = (code: string) => typeCheckSpindleCode(code, declarations);

const messages = (code: string): string =>
	check(code)
		.errors.map((error) => error.message)
		.join("\n");

/** Present in the engine, so `lib` must carry a real signature for each. */
const TYPED: Array<[string, string]> = [
	["Object.groupBy", "Object.groupBy();"],
	["Map.groupBy", "Map.groupBy();"],
	["Promise.withResolvers", "Promise.withResolvers(1);"],
	["Promise.try", "Promise.try();"],
	["Set.prototype.union", "new Set().union();"],
	["Set.prototype.isSubsetOf", "new Set().isSubsetOf();"],
	["RegExp.escape", "RegExp.escape();"],
	["Math.f16round", "Math.f16round();"],
	["Array.prototype.toSorted", "[1].toSorted(1, 2);"],
	["String.prototype.isWellFormed", "''.isWellFormed(1);"],
	["Error.isError", "Error.isError();"],
];

for (const [name, code] of TYPED) {
	test(`${name} resolves to a real signature, not any`, () => {
		assert.match(messages(code), /Expected (at least )?\d+(-\d+)? argument/);
	});
}

/** Correct usage of the same APIs must type-check clean. */
test("ES2024 and ES2025 APIs the engine implements type-check clean", () => {
	const result = check(
		[
			"const grouped = Object.groupBy([1, 2, 3], (n) => (n % 2 === 0 ? 'even' : 'odd'));",
			"const byKey = Map.groupBy([1, 2], (n) => n % 2);",
			"const { promise, resolve } = Promise.withResolvers<number>();",
			"resolve(1);",
			"const merged = new Set([1]).union(new Set([2]));",
			"const mapped = [1, 2].values().map((n) => n * 2).toArray();",
			"const safe = RegExp.escape('a.b');",
			"const sorted = [3, 1].toSorted((a, b) => a - b);",
			"const half = Math.f16round(1.5);",
			"const wellFormed = 'a'.isWellFormed();",
			"const isErr = Error.isError(new Error('x'));",
			"return [grouped, byKey, promise, merged, mapped, safe, sorted, half, wellFormed, isErr];",
		].join("\n"),
	);
	assert.deepEqual(result.errors, []);
});

/**
 * The engine lacks these, so the tier must stay at es2025 rather than esnext.
 * Untyped means they resolve to `any` and an arity mistake goes unreported,
 * which is exactly the signal that the tier has not crept forward.
 */
const UNTYPED: Array<[string, string]> = [
	["Array.fromAsync", "Array.fromAsync();"],
	["JSON.rawJSON", "JSON.rawJSON();"],
];

for (const [name, code] of UNTYPED) {
	test(`${name} stays untyped because the engine lacks it`, () => {
		assert.doesNotMatch(messages(code), /Expected (at least )?\d+(-\d+)? argument/);
	});
}

test("the guest declarations still parse as a standalone d.ts", () => {
	const result = check("return 1;");
	assert.deepEqual(result.errors, []);
});
