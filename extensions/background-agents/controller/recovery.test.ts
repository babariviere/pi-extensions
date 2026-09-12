import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { BackgroundAgentsDatabase } from "./database.ts";
import { GitRepository, spawnCommandRunner } from "./git/repository.ts";
import { GitWorktreeManager } from "./git/worktree.ts";
import { RecoveryCoordinator, type WorktreeInspector } from "./recovery.ts";

const directories: string[] = [];
function databasePath(): string {
	const directory = mkdtempSync(join(tmpdir(), "background-agents-recovery-"));
	directories.push(directory);
	return join(directory, "controller.sqlite");
}
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function runningAttempt(
	database: BackgroundAgentsDatabase,
	worktree = "/tmp/worktree",
): { attemptId: string; jobId: string } {
	const caseId = database.createCase({ title: "Recovery", source: "manual" });
	const jobId = database.createJob({ caseId, role: "worker" });
	const claim = database.claimJob(jobId, "original", 60_000, new Date("2026-01-01T00:00:00Z"))!;
	database.run(
		"UPDATE attempts SET systemd_unit = ?, worktree = ? WHERE id = ?",
		"background-test.service",
		worktree,
		claim.attemptId,
	);
	return { attemptId: claim.attemptId, jobId };
}

async function git(cwd: string, args: string[]): Promise<string> {
	const result = await spawnCommandRunner("git", ["-C", cwd, ...args]);
	if (result.code !== 0) throw new Error(result.stderr || result.stdout);
	return result.stdout;
}

describe("background-agents recovery", () => {
	test("reconciles systemd before replacing, quarantines dirty work, and uses a trusted checkpoint", async () => {
		const database = new BackgroundAgentsDatabase(databasePath());
		const { attemptId, jobId } = runningAttempt(database);
		const checkpointId = database.recordTrustedCheckpoint({
			attemptId,
			kind: "context",
			path: "/tmp/checkpoint.json",
		});
		const calls: string[] = [];
		const worktrees: WorktreeInspector = {
			async inspect() {
				calls.push("inspect-worktree");
				return { state: "dirty" };
			},
			async quarantine() {
				calls.push("quarantine");
				return "/tmp/worktree.quarantine";
			},
		};
		const recovery = new RecoveryCoordinator(database, {
			owner: "recovery",
			now: () => new Date("2026-01-01T00:01:00Z"),
			systemd: {
				async inspect() {
					calls.push("inspect-systemd");
					return "failed";
				},
			},
			worktrees,
		});
		const result = await recovery.reconcileAttempt(attemptId);
		assert.equal(result.action, "replaced");
		assert.equal(result.checkpoint?.id, checkpointId);
		assert.deepEqual(calls, ["inspect-systemd", "inspect-worktree", "quarantine"]);
		assert.equal(
			database.get<{ state: string }>("SELECT state FROM attempts WHERE id = ?", attemptId)?.state,
			"failed",
		);
		assert.equal(result.replacement?.generation, 2);
		assert.equal(database.get<{ state: string }>("SELECT state FROM jobs WHERE id = ?", jobId)?.state, "queued");
		assert.equal(
			database.get<{ state: string; profile_id: string | null; model: string | null }>(
				"SELECT state, profile_id, model FROM attempts WHERE id = ?",
				result.replacement?.attemptId,
			)?.state,
			"queued",
		);
		database.upsertProviderProfileState({ profileId: "recovery-profile", concurrencyLimit: 1 });
		const dispatched = database.claimJob(jobId, "provider", 60_000, new Date("2026-01-01T00:02:00Z"), {
			profileId: "recovery-profile",
			model: "recovery-model",
		});
		assert.equal(dispatched?.attemptId, result.replacement?.attemptId);
		assert.equal(dispatched?.profileId, "recovery-profile");
		assert.equal(dispatched?.model, "recovery-model");
		const decisions = database.all<{ decision: string }>(
			"SELECT decision FROM recovery_decisions WHERE attempt_id = ? ORDER BY rowid",
			attemptId,
		);
		assert.deepEqual(
			decisions.map((item) => item.decision),
			["observed", "quarantine", "replace-from-trusted-checkpoint"],
		);
		database.close();
	});

	test("does not replace from an untrusted or absent checkpoint", async () => {
		const database = new BackgroundAgentsDatabase(databasePath());
		const { attemptId, jobId } = runningAttempt(database);
		const recovery = new RecoveryCoordinator(database, {
			owner: "recovery",
			systemd: { inspect: async () => "inactive" },
			worktrees: { inspect: async () => ({ state: "clean" }), quarantine: async () => "/tmp/quarantine" },
		});
		const result = await recovery.reconcileAttempt(attemptId);
		assert.equal(result.action, "needs-human");
		assert.equal(
			database.get<{ state: string }>("SELECT state FROM attempts WHERE id = ?", attemptId)?.state,
			"needs-human",
		);
		assert.equal(database.get<{ state: string }>("SELECT state FROM jobs WHERE id = ?", jobId)?.state, "needs-human");
		assert.equal(
			database.get<{ decision: string }>("SELECT decision FROM recovery_decisions ORDER BY rowid DESC LIMIT 1")
				?.decision,
			"needs-human",
		);
		database.close();
	});

	test("quarantines through Git so a replacement can reuse the original branch", async () => {
		const database = new BackgroundAgentsDatabase(databasePath());
		const repositoryRoot = mkdtempSync(join(tmpdir(), "background-agents-recovery-git-"));
		directories.push(repositoryRoot);
		const primary = join(repositoryRoot, "primary");
		const worktrees = join(repositoryRoot, "worktrees");
		const caseId = database.createCase({ title: "Git recovery", source: "manual" });
		const jobId = database.createJob({ caseId, role: "worker" });
		try {
			await git(repositoryRoot, ["init", "-q", "-b", "main", primary]);
			await git(primary, ["config", "user.email", "background@example.test"]);
			await git(primary, ["config", "user.name", "Background Agent"]);
			writeFileSync(join(primary, "README.md"), "initial\n");
			await git(primary, ["add", "README.md"]);
			await git(primary, ["commit", "-qm", "initial"]);
			const manager = new GitWorktreeManager(new GitRepository(primary), worktrees);
			const original = await manager.ensure({ caseId, ordinal: 1, owner: "original", baseRef: "main" });
			writeFileSync(join(original.path, "dirty.txt"), "preserve this\n");
			const claim = database.claimJob(jobId, "original", 60_000, new Date("2026-01-01T00:00:00Z"))!;
			database.run(
				"UPDATE attempts SET systemd_unit = ?, worktree = ? WHERE id = ?",
				"background-test.service",
				original.path,
				claim.attemptId,
			);
			const checkpointId = database.recordTrustedCheckpoint({
				attemptId: claim.attemptId,
				kind: "context",
				path: "/tmp/checkpoint.json",
			});
			const recovery = new RecoveryCoordinator(database, {
				owner: "recovery",
				systemd: { inspect: async () => "failed" },
			});

			const result = await recovery.reconcileAttempt(claim.attemptId);
			assert.equal(result.action, "replaced");
			assert.equal(result.checkpoint?.id, checkpointId);
			assert.ok(result.quarantinedPath);
			assert.equal(readFileSync(join(result.quarantinedPath, "dirty.txt"), "utf8"), "preserve this\n");

			const replacement = await new GitWorktreeManager(new GitRepository(primary), worktrees).ensure({
				caseId,
				ordinal: 1,
				owner: "replacement",
				baseRef: "main",
			});
			assert.equal(replacement.branch, `background/${caseId}/1`);
			assert.equal(replacement.dirty, false);
			const registry = await git(primary, ["worktree", "list", "--porcelain"]);
			assert.match(registry, new RegExp(`${result.quarantinedPath}\\n[\\s\\S]*detached`));
			assert.match(registry, new RegExp(`${replacement.path}\\n[\\s\\S]*branch refs/heads/background/${caseId}/1`));
		} finally {
			database.close();
		}
	});
});
