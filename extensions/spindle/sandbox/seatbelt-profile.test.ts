import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { SandboxPolicy } from "./policy.ts";
import { buildSeatbeltProfile } from "./seatbelt-profile.ts";

/** Lines this module itself generates, as opposed to a vendored fragment's own
 * internal deny/allow lines: identified by the param-key prefixes only this
 * module mints, or by the denyWrite regex-deny shape it emits. */
const OWN_DENY_MARKER = /WRITABLE_ROOT|READABLE_ROOT_0_EXCLUDED|PROTECTED_ANCESTOR|\(deny file-write\* \(regex/;

const basePolicy = (overrides: Partial<SandboxPolicy> = {}): SandboxPolicy => ({
	mode: "workspace-write",
	allowWrite: [],
	denyWrite: [],
	denyRead: [],
	...overrides,
});

// Pre-resolved so the fixture paths below already match what canonicalizeRoot
// will hand back for an ordinary (non-symlinked) root: the top-level alias
// normalization (`/tmp` -> `/private/tmp`) is exercised on its own in the
// first test, not incidentally through every fixture in this file.
let fixtureDir: string;

beforeEach(() => {
	fixtureDir = realpathSync(mkdtempSync(join(tmpdir(), "seatbelt-profile-")));
});

afterEach(() => {
	rmSync(fixtureDir, { recursive: true, force: true });
});

test("/tmp in allowWrite resolves to the real path, not the top-level alias", () => {
	const result = buildSeatbeltProfile(basePolicy({ allowWrite: ["/tmp"] }));
	const values = result.params.map(([, value]) => value);
	const resolvedTmp = realpathSync("/tmp");
	assert.ok(values.includes(resolvedTmp), `expected ${resolvedTmp} among ${values.join(", ")}`);
	if (resolvedTmp !== "/tmp") {
		assert.ok(!values.includes("/tmp"), "the unresolved alias must never be handed to sandbox-exec as a param value");
	}
});

test("a symlinked writable root resolves to its target and warns", () => {
	const real = join(fixtureDir, "real");
	const link = join(fixtureDir, "link");
	mkdirSync(real);
	symlinkSync(real, link);
	const result = buildSeatbeltProfile(basePolicy({ allowWrite: [link] }));
	const values = result.params.map(([, value]) => value);
	assert.ok(values.includes(real), `expected the resolved target ${real} among ${values.join(", ")}`);
	assert.ok(
		result.warnings.some((warning) => warning.includes(link) && warning.includes(real)),
		`expected a warning naming both ${link} and ${real}, got: ${result.warnings.join(" | ")}`,
	);
});

test("exactly one root-anchor unlink deny per writable root", () => {
	const a = join(fixtureDir, "a");
	const b = join(fixtureDir, "b");
	mkdirSync(a);
	mkdirSync(b);
	const result = buildSeatbeltProfile(basePolicy({ allowWrite: [a, b] }));
	const matches = result.profile.match(
		/\(deny file-write-unlink \(require-all \(literal \(param "WRITABLE_ROOT_\d+"\)\) \(vnode-type DIRECTORY\)\)\)/g,
	);
	assert.equal(matches?.length, 2);
});

test("two allowWrite entries that canonicalize to the same path collapse to exactly one root filter and one unlink deny", () => {
	// Mirrors the real collision in toolCacheRoots ("/tmp" and "/private/tmp"):
	// two different original strings that resolve to the same canonical path.
	const real = join(fixtureDir, "real");
	const link = join(fixtureDir, "link");
	mkdirSync(real);
	symlinkSync(real, link);
	const result = buildSeatbeltProfile(basePolicy({ allowWrite: [real, link] }));

	const writableRootParams = result.params.filter(([key]) => key.startsWith("WRITABLE_ROOT"));
	assert.equal(writableRootParams.length, 1, `expected exactly one WRITABLE_ROOT param, got ${writableRootParams.length}`);
	assert.equal(writableRootParams[0]?.[1], real);

	const unlinkMatches = result.profile.match(
		/\(deny file-write-unlink \(require-all \(literal \(param "WRITABLE_ROOT_\d+"\)\) \(vnode-type DIRECTORY\)\)\)/g,
	);
	assert.equal(unlinkMatches?.length, 1);

	const rootFilterMatches = result.profile.match(/\(subpath \(param "WRITABLE_ROOT_\d+"\)\)/g);
	assert.equal(rootFilterMatches?.length, 1);
});

test("every denyRead root appears as both a literal and a subpath carve-out", () => {
	const secret = join(fixtureDir, "secret");
	mkdirSync(secret);
	const result = buildSeatbeltProfile(basePolicy({ allowWrite: [fixtureDir], denyRead: [secret] }));
	const key = result.params.find(([, value]) => value === secret)?.[0];
	assert.ok(key, "the denyRead root must be interned as a param");
	assert.ok(result.profile.includes(`(require-not (literal (param "${key}")))`));
	assert.ok(result.profile.includes(`(require-not (subpath (param "${key}")))`));
});

test("the last non-empty rule is a rename-escape deny when one is generated", () => {
	mkdirSync(join(fixtureDir, "nested"), { recursive: true });
	const secret = join(fixtureDir, "nested", "secret");
	mkdirSync(secret);
	const result = buildSeatbeltProfile(basePolicy({ allowWrite: [fixtureDir], denyRead: [secret] }));
	const lines = result.profile
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	const last = lines[lines.length - 1];
	assert.match(last as string, /PROTECTED_ANCESTOR/);

	// No allow line follows any of our own generated deny lines (the vendored
	// fragments' own internal ordering, e.g. "(deny default)" at the very top
	// of base.sbpl, is out of scope: this checks the sections this module
	// assembles, not the upstream text).
	const denyIndex = lines.findIndex((line) => line.includes("PROTECTED_ANCESTOR"));
	assert.ok(denyIndex >= 0);
	for (let i = denyIndex; i < lines.length; i++) {
		assert.ok(!lines[i]?.startsWith("(allow"), `found an allow line after the rename-escape denies: ${lines[i]}`);
	}
});

test("no allow line anywhere in the assembled profile follows a deny line this module itself generated", () => {
	// The earlier test above only checks from the PROTECTED_ANCESTOR block
	// onward, which is why the root-anchor unlink denies used to sneak in
	// between the write-allow section and the vendored fragments' own allow
	// sections without anything catching it. This one checks the *whole*
	// profile: SBPL's last-matching-rule-wins semantics mean any "(allow"
	// line, from us or a vendored fragment, that appears after our first own
	// "(deny" line can silently reopen what that deny was protecting.
	const a = join(fixtureDir, "a");
	mkdirSync(a);
	const secret = join(fixtureDir, "secret");
	mkdirSync(secret);
	const result = buildSeatbeltProfile(basePolicy({ allowWrite: [a], denyRead: [secret], denyWrite: [".env"] }));
	const lines = result.profile
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	const firstOwnDenyIndex = lines.findIndex((line) => line.startsWith("(deny") && OWN_DENY_MARKER.test(line));
	assert.ok(firstOwnDenyIndex >= 0, "expected at least one self-generated deny line");
	for (let i = firstOwnDenyIndex; i < lines.length; i++) {
		assert.ok(!lines[i]?.startsWith("(allow"), `found an allow line after a self-generated deny: ${lines[i]}`);
	}
});

test("a denyRead root that cannot be canonicalized (e.g. a symlink loop) makes buildSeatbeltProfile throw rather than drop it", () => {
	const nested = join(fixtureDir, "nested");
	mkdirSync(nested);
	const loop = join(nested, "loop");
	symlinkSync(loop, loop); // self-referential symlink: realpathSync(loop) always throws ELOOP.
	assert.throws(
		() => buildSeatbeltProfile(basePolicy({ denyRead: [loop] })),
		/sandbox: denyRead root '.*' could not be canonicalized/,
	);
});

test("denyWrite globs translate to seatbelt regex denies", () => {
	const result = buildSeatbeltProfile(basePolicy({ denyWrite: [".env"] }));
	assert.ok(result.profile.includes('(deny file-write* (regex #"^(.*/)?\\.env(/.*)?$"))'));
});

test("no param value ever appears spliced into the profile text, and every param is referenced", () => {
	const secret = join(fixtureDir, "secret");
	mkdirSync(secret);
	const result = buildSeatbeltProfile(
		basePolicy({ allowWrite: [fixtureDir], denyRead: [secret], denyWrite: [".env", "*.pem"] }),
	);
	for (const [key, value] of result.params) {
		// "/" (the root read param's value) is a degenerate case: it is a
		// substring of virtually every path-shaped string in the profile, so it
		// carries no signal here. Every other value is a real path and must never
		// appear spliced in.
		if (value !== "/") {
			assert.ok(!result.profile.includes(value), `param value ${value} must not appear spliced into the profile`);
		}
		assert.ok(result.profile.includes(`(param "${key}")`), `param ${key} is defined but never referenced`);
	}
	const paramRefs = [...result.profile.matchAll(/\(param "([^"]+)"\)/g)].map((m) => m[1]);
	const definedKeys = new Set(result.params.map(([key]) => key));
	for (const ref of paramRefs) {
		assert.ok(definedKeys.has(ref as string), `(param "${ref}") has no matching -D entry`);
	}
});

test("network is always unrestricted, and file-map-executable is granted for the read root", () => {
	const result = buildSeatbeltProfile(basePolicy({ allowWrite: [] }));
	assert.ok(result.profile.includes("(allow network*)"));
	assert.ok(result.profile.includes("(allow system-socket)"));
	assert.ok(result.profile.includes("com.apple.trustd.agent"));
	assert.ok(result.profile.includes("file-map-executable"));
});

test("an empty allowWrite emits no write allow and no WRITABLE_ROOT param", () => {
	const result = buildSeatbeltProfile(basePolicy({ allowWrite: [] }));
	// The vendored platform defaults legitimately contain their own single-line
	// "(allow file-write* (regex ...))" rule; only our own multi-root wrapper
	// (root filter on its own line, immediately after the opener) would signal
	// a writable-root grant.
	assert.ok(
		!/\(allow file-write\*\n\s*\((subpath|literal|require-all)/.test(result.profile),
		"no generated write-allow rule should be emitted",
	);
	assert.ok(!result.params.some(([key]) => key.startsWith("WRITABLE_ROOT")));
});

test("a missing writable root is kept as a subpath param rather than dropped", () => {
	const missing = join(fixtureDir, "does-not-exist-yet");
	const result = buildSeatbeltProfile(basePolicy({ allowWrite: [missing] }));
	const key = result.params.find(([, value]) => value === missing)?.[0];
	assert.ok(key, "a missing root must still be interned");
	assert.ok(result.profile.includes(`(subpath (param "${key}"))`));
	assert.equal(result.warnings.length, 0);
});
