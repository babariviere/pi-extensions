import assert from "node:assert/strict";
import { test } from "node:test";
import { isBlockedFetchHost, isRawGitHubUrl, isSafeSegment, parseGitHubRepoUrl } from "./utils.ts";

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

test("isBlockedFetchHost flags loopback, private, and link-local hosts", () => {
	for (const host of [
		"localhost",
		"api.localhost",
		"127.0.0.1",
		"0.0.0.0",
		"10.1.2.3",
		"172.16.0.1",
		"172.31.255.255",
		"192.168.1.1",
		"169.254.169.254",
		"100.64.0.1",
		"::1",
		"fe80::1",
		"fd00::1",
		"::ffff:127.0.0.1",
	]) {
		assert.equal(isBlockedFetchHost(host), true, `expected ${host} to be blocked`);
	}
});

test("isBlockedFetchHost allows public hosts", () => {
	for (const host of ["example.com", "8.8.8.8", "172.32.0.1", "192.169.0.1", "1.1.1.1"]) {
		assert.equal(isBlockedFetchHost(host), false, `expected ${host} to be allowed`);
	}
});
