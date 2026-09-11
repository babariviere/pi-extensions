import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { BackgroundAgentsDatabase } from "./database.ts";
import { JobScheduler } from "./jobs.ts";
import { BackgroundAgentsStateMachine } from "./state-machine.ts";

const directories: string[] = [];

function databasePath(): string {
	const directory = mkdtempSync(join(tmpdir(), "background-agents-jobs-"));
	directories.push(directory);
	return join(directory, "controller.sqlite");
}

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("background-agents durable jobs", () => {
	test("claims jobs in deterministic priority order and honors the emergency stop gate", () => {
		const database = new BackgroundAgentsDatabase(databasePath());
		const scheduler = new JobScheduler(database);
		const caseId = database.createCase({ title: "Queue", source: "manual" });
		scheduler.queueJob({ id: "low", caseId, role: "investigator", priority: 1 });
		scheduler.queueJob({ id: "high", caseId, role: "investigator", priority: 10 });
		const first = scheduler.claimNext("worker", 1000, new Date("2026-01-01T00:00:00Z"));
		assert.equal(first?.jobId, "high");
		scheduler.setEmergencyStop(true);
		assert.equal(scheduler.claimNext("worker", 1000), null);
		scheduler.setEmergencyStop(false);
		assert.equal(scheduler.claimNext("worker", 1000, new Date("2026-01-01T00:00:00Z"))?.jobId, "low");
		database.close();
	});

	test("does not claim a child stack item before its parent is verified", () => {
		const database = new BackgroundAgentsDatabase(databasePath());
		const scheduler = new JobScheduler(database);
		const machine = new BackgroundAgentsStateMachine(database);
		const caseId = database.createCase({ title: "Stack", source: "manual" });
		const parentId = machine.createWorkItem({ caseId, ordinal: 1, title: "Parent" });
		const childId = machine.createWorkItem({ caseId, ordinal: 2, parentId, title: "Child" });
		const childJob = scheduler.queueJob({ caseId, workItemId: childId, role: "worker" });
		assert.equal(scheduler.claimNext("worker"), null);
		machine.transitionWorkItem(parentId, "implementation", "test");
		machine.transitionWorkItem(parentId, "verification", "test");
		machine.transitionWorkItem(parentId, "verified", "test");
		assert.equal(scheduler.claimNext("worker")?.jobId, childJob);
		database.close();
	});

	test("renews leases, rejects unauthorized completion, and records completion durably", () => {
		const database = new BackgroundAgentsDatabase(databasePath());
		const scheduler = new JobScheduler(database);
		const caseId = database.createCase({ title: "Attempt", source: "manual" });
		const jobId = scheduler.queueJob({ caseId, role: "worker" });
		const start = new Date("2026-01-01T00:00:00Z");
		const claim = scheduler.claim(jobId, "worker-a", 1000, start)!;
		assert.equal(
			scheduler.renewLease(claim.attemptId, "worker-b", 1000, new Date("2026-01-01T00:00:00.500Z")),
			false,
		);
		assert.equal(scheduler.renewLease(claim.attemptId, "worker-a", 1000, new Date("2026-01-01T00:00:00.500Z")), true);
		assert.equal(
			scheduler.finishAttempt(
				{ attemptId: claim.attemptId, state: "succeeded", now: new Date("2026-01-01T00:00:00.750Z") },
				"worker-b",
			),
			false,
		);
		assert.equal(
			scheduler.finishAttempt(
				{ attemptId: claim.attemptId, state: "succeeded", now: new Date("2026-01-01T00:00:00.750Z") },
				"worker-a",
			),
			true,
		);
		assert.equal(database.get<{ state: string }>("SELECT state FROM jobs WHERE id = ?", jobId)?.state, "succeeded");
		assert.equal(database.get<{ count: number }>("SELECT count(*) AS count FROM attempt_leases")?.count, 0);
		database.close();
	});

	test("expires a lease into a queued retry with a new generation", () => {
		const database = new BackgroundAgentsDatabase(databasePath());
		const scheduler = new JobScheduler(database);
		const caseId = database.createCase({ title: "Expiry", source: "manual" });
		const jobId = scheduler.queueJob({ caseId, role: "verifier" });
		const start = new Date("2026-01-01T00:00:00Z");
		const first = scheduler.claim(jobId, "worker-a", 100, start)!;
		assert.equal(scheduler.reconcileExpiredLeases(new Date("2026-01-01T00:00:00.100Z")), 1);
		assert.equal(
			database.get<{ state: string; failure: string }>(
				"SELECT state, failure FROM attempts WHERE id = ?",
				first.attemptId,
			)?.state,
			"failed",
		);
		assert.equal(database.get<{ state: string }>("SELECT state FROM jobs WHERE id = ?", jobId)?.state, "queued");
		const second = scheduler.claim(jobId, "worker-b", 100, new Date("2026-01-01T00:00:01Z"));
		assert.equal(second?.generation, 2);
		database.close();
	});

	test("pauses and resumes queued work without reviving an old attempt", () => {
		const database = new BackgroundAgentsDatabase(databasePath());
		const scheduler = new JobScheduler(database);
		const caseId = database.createCase({ title: "Pause jobs", source: "manual" });
		const jobId = scheduler.queueJob({ caseId, role: "investigator" });
		const claim = scheduler.claim(jobId, "worker", 1000)!;
		assert.equal(scheduler.pauseCaseJobs(caseId), 1);
		assert.equal(database.get<{ state: string }>("SELECT state FROM jobs WHERE id = ?", jobId)?.state, "paused");
		assert.equal(
			database.get<{ state: string }>("SELECT state FROM attempts WHERE id = ?", claim.attemptId)?.state,
			"paused",
		);
		assert.equal(scheduler.resumeCaseJobs(caseId), 1);
		const replacement = scheduler.claimNext("worker", 1000);
		assert.equal(replacement?.generation, 2);
		database.close();
	});
});
