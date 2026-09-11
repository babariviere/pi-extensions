import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { BackgroundAgentsDatabase } from "./database.ts";
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

function runningAttempt(database: BackgroundAgentsDatabase): { attemptId: string; jobId: string } {
	const caseId = database.createCase({ title: "Recovery", source: "manual" });
	const jobId = database.createJob({ caseId, role: "worker" });
	const claim = database.claimJob(jobId, "original", 60_000, new Date("2026-01-01T00:00:00Z"))!;
	database.run(
		"UPDATE attempts SET systemd_unit = ?, worktree = ? WHERE id = ?",
		"background-test.service",
		"/tmp/worktree",
		claim.attemptId,
	);
	return { attemptId: claim.attemptId, jobId };
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
		assert.equal(database.get<{ state: string }>("SELECT state FROM jobs WHERE id = ?", jobId)?.state, "running");
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
});
