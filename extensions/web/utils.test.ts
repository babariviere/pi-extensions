import assert from "node:assert/strict";
import { test } from "node:test";
import { isRawGitHubUrl, isSafeSegment, parseGitHubRepoUrl } from "./utils.ts";

test("isSafeSegment accepts plain owner/repo names", () => {
	assert.equal(isSafeSegment("babariviere"), true);
	assert.equal(isSafeSegment("pi-extensions"), true);
	assert.equal(isSafeSegment("repo.name_1"), true);
});

test("isSafeSegment rejects traversal and shell-sensitive input", () => {
	for (const bad of ["..", ".", "a/b", "$(x)", "-flag", "", "a b", "a;b", "a`b"]) {
		assert.equal(isSafeSegment(bad), false, `expected ${JSON.stringify(bad)} to be rejected`);
	}
});

test("parseGitHubRepoUrl accepts root, tree, and blob URLs", () => {
	const root = parseGitHubRepoUrl("https://github.com/owner/repo");
	assert.deepEqual(root, {
		owner: "owner",
		repo: "repo",
		cloneUrl: "https://github.com/owner/repo.git",
	});
	assert.ok(parseGitHubRepoUrl("https://github.com/owner/repo/tree/main/src"));
	assert.ok(parseGitHubRepoUrl("https://github.com/owner/repo/blob/main/x.ts"));
});

test("parseGitHubRepoUrl strips a trailing .git", () => {
	assert.equal(parseGitHubRepoUrl("https://github.com/owner/repo.git")?.repo, "repo");
});

test("parseGitHubRepoUrl rejects non-repo paths and foreign hosts", () => {
	assert.equal(parseGitHubRepoUrl("https://github.com/owner/repo/issues/1"), null);
	assert.equal(parseGitHubRepoUrl("https://github.com/owner/repo/pull/2"), null);
	assert.equal(parseGitHubRepoUrl("https://github.com/owner"), null);
	assert.equal(parseGitHubRepoUrl("https://gitlab.com/owner/repo"), null);
	assert.equal(parseGitHubRepoUrl("not a url"), null);
});

test("isRawGitHubUrl only matches https raw.githubusercontent.com", () => {
	assert.equal(isRawGitHubUrl("https://raw.githubusercontent.com/o/r/main/f"), true);
	assert.equal(isRawGitHubUrl("http://raw.githubusercontent.com/o/r/main/f"), false);
	assert.equal(isRawGitHubUrl("https://github.com/o/r"), false);
});
