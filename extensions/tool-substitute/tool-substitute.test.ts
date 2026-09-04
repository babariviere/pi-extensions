import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import toolSubstitute, { findGitWrites, findJjRoot, gitSubcommand } from "./index.ts";

const BASE = "/repo";

function writes(command: string, base: string | undefined = BASE) {
	return findGitWrites(command, base).map((w) => `${w.subcommand}@${w.cwd ?? "?"}`);
}

test("gitSubcommand skips global flags", () => {
	assert.equal(gitSubcommand(["git", "log"]), "log");
	assert.equal(gitSubcommand(["git", "--no-pager", "diff"]), "diff");
	assert.equal(gitSubcommand(["git", "-C", "/tmp", "commit"]), "commit");
	assert.equal(gitSubcommand(["git"]), "");
});

test("read-only git is not reported", () => {
	for (const cmd of ["git status", "git log --oneline", "git diff HEAD", "git show abc", "git blame f"]) {
		assert.deepEqual(writes(cmd), [], cmd);
	}
});

test("git writes are reported with the session cwd", () => {
	assert.deepEqual(writes("git commit -m x"), ["commit@/repo"]);
	assert.deepEqual(writes("ls && git rebase -i"), ["rebase@/repo"]);
	assert.deepEqual(writes("GIT_PAGER=cat git reset --hard"), ["reset@/repo"]);
	assert.deepEqual(writes("env git add ."), ["add@/repo"]);
	assert.deepEqual(writes("/usr/bin/git checkout main"), ["checkout@/repo"]);
	assert.deepEqual(writes("sudo -E git clean -fd"), ["clean@/repo"]);
});

test("cd changes the directory a write is judged against", () => {
	assert.deepEqual(writes("cd /other && git commit -m x"), ["commit@/other"]);
	assert.deepEqual(writes("cd sub && git commit -m x"), ["commit@/repo/sub"]);
	assert.deepEqual(writes("cd /a; cd ../b; git commit"), ["commit@/b"]);
});

test("git -C retargets the write", () => {
	assert.deepEqual(writes("git -C /other commit -m x"), ["commit@/other"]);
	assert.deepEqual(writes("git -C sub add ."), ["add@/repo/sub"]);
});

test("unresolvable directories are reported as unknown", () => {
	assert.deepEqual(writes("cd $HOME/x && git commit"), ["commit@?"]);
	assert.deepEqual(writes("cd - && git commit"), ["commit@?"]);
	assert.deepEqual(findGitWrites("git commit", undefined), [{ subcommand: "commit", cwd: undefined }]);
});

test("remote executors are skipped", () => {
	assert.deepEqual(writes("ssh host 'git commit -m x'"), []);
	assert.deepEqual(writes("docker run img git commit"), []);
});

test("nested shell payloads are scanned", () => {
	assert.deepEqual(writes(`bash -c 'git commit -m x'`), ["commit@/repo"]);
	assert.deepEqual(writes(`bash -c 'cd /other && git reset'`), ["reset@/other"]);
	assert.deepEqual(writes(`sh -c "git status"`), []);
});

test("findJjRoot walks up to the .jj directory", () => {
	const base = mkdtempSync(join(tmpdir(), "jjroot-"));
	mkdirSync(join(base, ".jj"));
	const nested = join(base, "a", "b");
	mkdirSync(nested, { recursive: true });
	assert.equal(findJjRoot(nested), base);

	const plain = mkdtempSync(join(tmpdir(), "plain-"));
	assert.equal(findJjRoot(plain), undefined);
});

test("emits explicit search syntax guidance", async () => {
	type Hook = (event: { systemPrompt: string }, context: unknown) => Promise<{ systemPrompt: string }>;
	let hook: Hook | undefined;
	const pi = {
		on(name: string, handler: unknown) {
			if (name === "before_agent_start") hook = handler as Hook;
		},
	} as unknown as ExtensionAPI;

	toolSubstitute(pi);
	assert.ok(hook);
	const result = await hook({ systemPrompt: "base prompt" }, undefined);

	assert.match(result.systemPrompt, /pi\.find\(\{ pattern: "\*\.test\.ts", path: "extensions" \}\)/);
	assert.match(result.systemPrompt, /pi\.grep\(\{ pattern: "setModel\(", path: "src", literal: true \}\)/);
	assert.match(result.systemPrompt, /optional `glob` filters file paths and does not change the content pattern/);
	assert.match(result.systemPrompt, /rg --fixed-strings --glob '\*\.ts' 'setModel\('/);
	assert.match(result.systemPrompt, /fd --glob '\*\.test\.ts'/);
	assert.match(result.systemPrompt, /Only when Pi search APIs lack required options or output formatting/);
});
