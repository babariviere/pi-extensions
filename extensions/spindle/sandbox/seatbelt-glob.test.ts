import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_DENY_WRITE, matchesPattern } from "./policy.ts";
import {
	escapeSeatbeltRegexLiteral,
	quoteSeatbeltRegex,
	seatbeltRegexForDenyPattern,
	seatbeltRegexForGlob,
} from "./seatbelt-glob.ts";

test("empty pattern has no translation", () => {
	assert.equal(seatbeltRegexForGlob("", "exact"), undefined);
});

test("* stays within one path component", () => {
	assert.equal(seatbeltRegexForGlob("*.pem", "exact"), "^[^/]*\\.pem$");
});

test("? matches exactly one non-slash character", () => {
	assert.equal(seatbeltRegexForGlob("a?b", "exact"), "^a[^/]b$");
});

test("** is just two single-component wildcards in a row, not a cross-component wildcard", () => {
	// Matches globToRegExp's char-by-char behavior exactly: there is no special
	// case for a doubled '*'.
	assert.equal(seatbeltRegexForGlob("a**b", "exact"), "^a[^/]*[^/]*b$");
});

test("a literal pattern gets no descendant suffix in exact mode", () => {
	assert.equal(seatbeltRegexForGlob("id_rsa", "exact"), "^id_rsa$");
});

test("a literal pattern gets a descendant suffix in subtree mode", () => {
	assert.equal(seatbeltRegexForGlob("id_rsa", "subtree"), "^id_rsa(/.*)?$");
});

test("a pattern with a glob metacharacter gets no descendant suffix even in subtree mode", () => {
	assert.equal(seatbeltRegexForGlob("*.pem", "subtree"), "^[^/]*\\.pem$");
});

test("brackets are literal characters, not a character class (matches policy.ts's globToRegExp)", () => {
	assert.equal(seatbeltRegexForGlob("[abc]", "exact"), "^\\[abc\\]$");
});

test("braces are literal characters, not an alternation group (matches policy.ts's globToRegExp)", () => {
	assert.equal(seatbeltRegexForGlob("*.{env,pem}", "exact"), "^[^/]*\\.\\{env,pem\\}$");
});

test("a comma is always a literal comma", () => {
	assert.equal(seatbeltRegexForGlob("a,b", "exact"), "^a,b$");
});

test("a backslash is a literal character, not an escape for the next one (matches policy.ts's globToRegExp)", () => {
	assert.equal(seatbeltRegexForGlob("a\\*b", "exact"), "^a\\\\[^/]*b$");
});

test("a trailing backslash is a literal backslash", () => {
	assert.equal(seatbeltRegexForGlob("a\\", "exact"), "^a\\\\$");
});

test("regex metacharacters outside glob syntax are escaped", () => {
	assert.equal(seatbeltRegexForGlob(".foo+bar", "exact"), "^\\.foo\\+bar$");
});

test("escapeSeatbeltRegexLiteral escapes every JS regex metacharacter", () => {
	assert.equal(escapeSeatbeltRegexLiteral(".*+?^${}()|[]\\"), "\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\");
});

test("quoteSeatbeltRegex escapes embedded double quotes", () => {
	assert.equal(quoteSeatbeltRegex('a"b'), 'a\\"b');
});

test("seatbeltRegexForDenyPattern: a slash anchors the full path, no descendant suffix", () => {
	assert.equal(seatbeltRegexForDenyPattern("/work/repo/dist/*"), "^/work/repo/dist/[^/]*$");
});

test("seatbeltRegexForDenyPattern: no slash matches a basename anywhere", () => {
	assert.equal(seatbeltRegexForDenyPattern(".env"), "^(.*/)?\\.env(/.*)?$");
	assert.equal(seatbeltRegexForDenyPattern("*.pem"), "^(.*/)?[^/]*\\.pem$");
});

test("every DEFAULT_DENY_WRITE pattern translates without throwing", () => {
	for (const pattern of DEFAULT_DENY_WRITE) {
		const regex = seatbeltRegexForDenyPattern(pattern);
		assert.ok(regex, `${pattern} did not translate`);
		// The translated regex must itself be a valid JS regex, since the
		// cross-check below runs it through RegExp.
		assert.doesNotThrow(() => new RegExp(regex as string));
	}
});

test("the translated regex agrees with matchesPattern for every DEFAULT_DENY_WRITE pattern", () => {
	// Deliberately excludes a path *under* a literal pattern name (e.g.
	// "/work/repo/.env/child"): the seatbelt regex denies those descendants too
	// (defense in depth, in case the "secret" is actually a directory), which is
	// stricter than matchesPattern's plain basename check, never looser. The
	// invariant this test protects is that the two never disagree on whether an
	// ordinary file is itself denied.
	const samples = [
		"/work/repo/.env",
		"/work/repo/.env.local",
		"/work/repo/certs/key.pem",
		"/work/repo/certs/key.pub",
		"/work/repo/certs/key.key",
		"/work/repo/certs/key.p12",
		"/work/repo/.ssh/id_rsa",
		"/work/repo/.ssh/id_ed25519",
		"/work/repo/src/a.ts",
	];
	for (const pattern of DEFAULT_DENY_WRITE) {
		const regex = new RegExp(seatbeltRegexForDenyPattern(pattern) as string);
		for (const sample of samples) {
			assert.equal(regex.test(sample), matchesPattern(pattern, sample), `pattern ${pattern} disagrees on ${sample}`);
		}
	}
});

test("the translated regex agrees with matchesPattern for patterns containing {}, [], **, and a backslash", () => {
	// Same caveat as above: samples deliberately avoid a path *under* a literal
	// pattern name, where the seatbelt regex's subtree-mode descendant suffix
	// is a documented, stricter-never-looser divergence, not something this
	// agreement test is meant to catch. Samples also avoid a literal backslash
	// in the *path*: matchesPattern's own basename extraction
	// (absolutePath.split(/[\\/]/)) treats a backslash as a path separator
	// wherever it appears in the candidate path, which is an existing property
	// of matchesPattern unrelated to how a pattern's own backslash is
	// translated, and orthogonal to what this test checks.
	const patterns = ["*.{env,pem}", "[secret]*", "**/*.key", "a\\*b", "id_{rsa,ed25519}"];
	const samples = [
		"/work/repo/x.env",
		"/work/repo/x.pem",
		"/work/repo/x.txt",
		"/work/repo/[secret]file",
		"/work/repo/secretfile",
		"/work/repo/a/b/x.key",
		"/work/repo/x.key",
		"/work/repo/a*b",
		"/work/repo/aXb",
		"/work/repo/id_{rsa,ed25519}",
		"/work/repo/id_rsa",
	];
	for (const pattern of patterns) {
		const regex = new RegExp(seatbeltRegexForDenyPattern(pattern) as string);
		for (const sample of samples) {
			assert.equal(regex.test(sample), matchesPattern(pattern, sample), `pattern ${pattern} disagrees on ${sample}`);
		}
	}
});
