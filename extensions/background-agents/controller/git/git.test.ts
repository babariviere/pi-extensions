import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { GitHubController } from "./github.ts";
import { GitRepository, spawnCommandRunner, type CommandRunner } from "./repository.ts";
import { GitStackController } from "./stack.ts";
import { backgroundBranch, GitWorktreeManager } from "./worktree.ts";

async function git(args: string[], cwd: string): Promise<string> {
	const result = await spawnCommandRunner("git", ["-C", cwd, ...args]);
	if (result.code !== 0) throw new Error(result.stderr || result.stdout);
	return result.stdout;
}

async function repositoryRoot(): Promise<{ root: string; primary: string; worktrees: string }> {
	const root = mkdtempSync(join(tmpdir(), "background-git-"));
	const primary = join(root, "primary");
	const worktrees = join(root, "worktrees");
	const remote = join(root, "remote.git");
	await git(["init", "-b", "main", primary], root);
	await git(["init", "--bare", remote], root);
	await git(["config", "user.email", "background@example.test"], primary);
	await git(["config", "user.name", "Background Agent"], primary);
	writeFileSync(join(primary, "README.md"), "initial\n");
	await git(["add", "README.md"], primary);
	await git(["commit", "-m", "initial"], primary);
	await git(["remote", "add", "origin", remote], primary);
	await git(["push", "-u", "origin", "main"], primary);
	return { root, primary, worktrees };
}

test("creates deterministic Git worktrees and preserves dirty worktrees across reconciliation", async () => {
	const paths = await repositoryRoot();
	try {
		const repository = new GitRepository(paths.primary);
		const manager = new GitWorktreeManager(repository, paths.worktrees);
		const first = await manager.ensure({ caseId: "case-1", ordinal: 1, owner: "worker-1", baseRef: "main" });
		assert.equal(first.branch, backgroundBranch("case-1", 1));
		assert.equal(first.path, join(realpathSync(paths.worktrees), "case-1", "1"));
		assert.equal((await git(["branch", "--show-current"], paths.primary)).trim(), "main");
		await assert.rejects(repository.push(paths.primary, "main"), /primary checkout is read-only/);
		assert.deepEqual(await manager.reconcileBranches("case-1"), ["background/case-1/1"]);

		writeFileSync(join(first.path, "dirty.txt"), "keep me\n");
		const restarted = new GitWorktreeManager(new GitRepository(paths.primary), paths.worktrees);
		const reconciled = await restarted.reconcile();
		const found = reconciled.find((record) => record.path === first.path);
		assert.equal(found?.dirty, true);
		const same = await restarted.ensure({
			caseId: "case-1",
			ordinal: 1,
			owner: "replacement-worker",
			baseRef: "main",
		});
		assert.equal(same.path, first.path);
		assert.equal(same.dirty, true);
	} finally {
		rmSync(paths.root, { recursive: true, force: true });
	}
});

test("delivers a sequential draft stack with argv-only GitHub operations", async () => {
	const paths = await repositoryRoot();
	try {
		const calls: Array<{ executable: string; args: string[] }> = [];
		let nextPullRequest = 10;
		const runner: CommandRunner = async (executable, args, options) => {
			calls.push({ executable, args: [...args] });
			if (executable !== "gh") return spawnCommandRunner(executable, args, options);
			if (args[0] === "pr" && args[1] === "create") {
				const branch = args[args.indexOf("--head") + 1];
				return {
					code: 0,
					stdout: JSON.stringify({
						number: nextPullRequest,
						url: `https://github.test/pr/${nextPullRequest++}`,
						headRefName: branch,
						baseRefName: args[args.indexOf("--base") + 1],
						isDraft: true,
					}),
					stderr: "",
				};
			}
			return { code: 0, stdout: "", stderr: "" };
		};
		const repository = new GitRepository(paths.primary, runner);
		const worktrees = new GitWorktreeManager(repository, paths.worktrees);
		const github = new GitHubController(repository);
		const stack = new GitStackController(worktrees, github);
		await assert.rejects(github.markReady(10, { passed: false }), /passed verification/);
		const verified: string[] = [];
		const result = await stack.deliver(
			[
				{ caseId: "case-2", ordinal: 1, owner: "owner-1", title: "Bottom", body: "bottom body" },
				{ caseId: "case-2", ordinal: 2, owner: "owner-2", title: "Top", body: "top body" },
			],
			{
				baseBranch: "main",
				verify: async ({ branch }) => {
					verified.push(branch);
					return { passed: true, verifiedCommit: await repository.branchCommit(branch), requiredCiPassed: true };
				},
			},
		);

		assert.deepEqual(verified, ["background/case-2/1", "background/case-2/2"]);
		assert.deepEqual(
			result.map((item) => item.base),
			["main", "background/case-2/1"],
		);
		const link = calls.find((call) => call.executable === "gh" && call.args[0] === "stack");
		assert.deepEqual(link?.args, ["stack", "link", "background/case-2/1", "background/case-2/2"]);
		assert.equal(
			calls.some((call) => call.args.includes("merge")),
			false,
		);
		assert.equal(
			calls.some((call) => call.executable === "sh" || call.executable === "bash"),
			false,
		);
	} finally {
		rmSync(paths.root, { recursive: true, force: true });
	}
});
