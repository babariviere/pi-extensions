import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { BackgroundAgentsDatabase, IllegalCaseTransitionError } from "./database.ts";
import { CURRENT_SCHEMA_VERSION } from "./migrations.ts";

const directories: string[] = [];

function databasePath(): string {
	const directory = mkdtempSync(join(tmpdir(), "background-agents-"));
	directories.push(directory);
	return join(directory, "controller.sqlite");
}

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("background-agents SQLite ownership", () => {
	test("runs a fresh migration and reopens with WAL and foreign keys", () => {
		const path = databasePath();
		const first = new BackgroundAgentsDatabase(path);
		assert.equal(
			first.get<{ version: number }>("SELECT max(version) AS version FROM schema_migrations")?.version,
			CURRENT_SCHEMA_VERSION,
		);
		assert.equal(first.get<{ foreign_keys: number }>("PRAGMA foreign_keys")?.foreign_keys, 1);
		assert.equal(first.get<{ journal_mode: string }>("PRAGMA journal_mode")?.journal_mode, "wal");
		assert.ok(
			readdirSync(join(path, ".."), { withFileTypes: true }).some(
				(entry) => entry.name === "controller.sqlite-wal" || entry.name === "controller.sqlite-shm",
			),
		);
		first.close();

		const reopened = new BackgroundAgentsDatabase(path);
		assert.equal(
			reopened.get<{ count: number }>("SELECT count(*) AS count FROM schema_migrations")?.count,
			CURRENT_SCHEMA_VERSION,
		);
		reopened.close();
	});

	test("deduplicates source events and creates one durable case", () => {
		const database = new BackgroundAgentsDatabase(databasePath());
		const event = {
			source: "manual" as const,
			sourceKey: "manual:42",
			revision: "1",
			receivedAt: "2026-01-01T12:00:00+01:00",
			title: "A report",
			body: "Details",
			metadata: { channel: "test" },
		};
		const first = database.recordSourceEvent(event);
		const second = database.recordSourceEvent(event);
		assert.equal(first.inserted, true);
		assert.equal(second.inserted, false);
		assert.equal(first.eventId, second.eventId);
		assert.equal(first.caseId, second.caseId);
		assert.equal(database.get<{ count: number }>("SELECT count(*) AS count FROM source_events")?.count, 1);
		assert.equal(database.get<{ count: number }>("SELECT count(*) AS count FROM cases")?.count, 1);
		assert.throws(() => database.exec("UPDATE source_events SET body = 'changed'"), /immutable/);
		database.close();
	});

	test("links later source revisions and advances their cursor atomically", () => {
		const database = new BackgroundAgentsDatabase(databasePath());
		const first = database.recordSourceEvent({
			source: "linear",
			sourceKey: "linear:revisioned",
			revision: "1",
			receivedAt: "2026-01-01T00:00:00Z",
			title: "First",
			body: "one",
		});
		const second = database.recordSourceEventAndAdvanceCursor(
			{
				source: "linear",
				sourceKey: "linear:revisioned",
				revision: "2",
				receivedAt: "2026-01-01T00:01:00Z",
				title: "Second",
				body: "two",
			},
			{ cursor: "page-2", revision: "2" },
		);
		assert.equal(second.caseId, first.caseId);
		assert.deepEqual(database.getSourceCursor("linear"), {
			source: "linear",
			cursor: "page-2",
			revision: "2",
			updatedAt: database.getSourceCursor("linear")?.updatedAt,
		});
		database.close();
	});

	test("enforces lifecycle transition boundaries and append-only events", () => {
		const database = new BackgroundAgentsDatabase(databasePath());
		const caseId = database.createCase({ title: "Lifecycle", source: "manual" });
		assert.throws(() => database.transitionCase(caseId, "handled", "test"), IllegalCaseTransitionError);
		database.transitionCase(caseId, "classified", "test", "classified");
		assert.equal(
			database.get<{ state: string }>("SELECT state FROM cases WHERE id = ?", caseId)?.state,
			"classified",
		);
		assert.throws(() => database.exec("UPDATE case_events SET actor = 'changed'"), /append-only/);
		database.close();
	});

	test("enforces foreign keys and rejects invalid JSON at the boundary", () => {
		const database = new BackgroundAgentsDatabase(databasePath());
		assert.throws(
			() =>
				database.exec(
					"INSERT INTO case_events (id, case_id, to_state, actor) VALUES ('x', 'missing', 'intake', 'test')",
				),
			/FOREIGN KEY/,
		);
		const cyclic: { self?: unknown } = {};
		cyclic.self = cyclic;
		assert.throws(
			() =>
				database.recordSourceEvent({
					source: "manual",
					sourceKey: "bad",
					receivedAt: new Date().toISOString(),
					title: "Bad",
					body: "",
					metadata: cyclic,
				}),
			/metadata must be JSON serializable/,
		);
		database.close();
	});

	test("expires and replaces job leases transactionally", () => {
		const database = new BackgroundAgentsDatabase(databasePath());
		const caseId = database.createCase({ title: "Lease", source: "manual" });
		const jobId = database.createJob({ caseId, role: "investigator" });
		const start = new Date("2026-01-01T00:00:00.000Z");
		const first = database.claimJob(jobId, "worker-a", 1000, start);
		assert.ok(first);
		assert.equal(database.renewLease(first.attemptId, "worker-a", 1000, new Date("2026-01-01T00:00:00.500Z")), true);
		assert.equal(database.renewLease(first.attemptId, "worker-a", 1000, new Date("2026-01-01T00:00:02.000Z")), false);
		const second = database.claimJob(jobId, "worker-b", 1000, new Date("2026-01-01T00:00:02.000Z"));
		assert.ok(second);
		assert.equal(second.generation, 2);
		database.close();
	});

	test("rejects a database with a newer schema version", () => {
		const path = databasePath();
		const database = new BackgroundAgentsDatabase(path);
		database.exec("PRAGMA user_version = 99");
		database.close();
		assert.throws(() => new BackgroundAgentsDatabase(path), /newer than the controller schema/);
	});

	test("persists emergency-stop ownership across restart and resumes only its jobs", () => {
		const path = databasePath();
		const first = new BackgroundAgentsDatabase(path);
		const firstCase = first.createCase({ title: "stop", source: "manual" });
		const firstJob = first.createJob({ caseId: firstCase, role: "investigator" });
		const otherCase = first.createCase({ title: "other", source: "manual" });
		const otherJob = first.createJob({ caseId: otherCase, role: "investigator" });
		first.run("UPDATE jobs SET state = 'paused' WHERE id = ?", otherJob);
		assert.equal(first.pauseEmergencyStopJobs([firstJob, otherJob]), 1);
		first.close();

		const reopened = new BackgroundAgentsDatabase(path);
		assert.equal(reopened.get<{ state: string }>("SELECT state FROM jobs WHERE id = ?", firstJob)?.state, "paused");
		assert.equal(reopened.get<{ state: string }>("SELECT state FROM jobs WHERE id = ?", otherJob)?.state, "paused");
		assert.equal(reopened.resumeEmergencyStopJobs(), 1);
		assert.equal(reopened.get<{ state: string }>("SELECT state FROM jobs WHERE id = ?", firstJob)?.state, "queued");
		assert.equal(reopened.get<{ state: string }>("SELECT state FROM jobs WHERE id = ?", otherJob)?.state, "paused");
		reopened.close();
	});

	test("persists stop attempts and invalidates stale publishers", () => {
		const path = databasePath();
		const first = new BackgroundAgentsDatabase(path);
		const caseId = first.createCase({ title: "epoch", source: "manual" });
		const jobId = first.createJob({ caseId, role: "investigator" });
		const claim = first.claimJob(jobId, "runner");
		assert.ok(claim);
		first.setEmergencyStop(true, "operator");
		assert.equal(first.attemptMayPublish(claim.attemptId, claim.stopEpoch), false);
		first.close();

		const reopened = new BackgroundAgentsDatabase(path);
		assert.equal(reopened.listEmergencyStopAttempts().length, 1);
		assert.throws(() => reopened.setEmergencyStop(false, "operator"), /not fully reconciled/);
		reopened.markEmergencyStopAttempt(claim.attemptId, { systemdConfirmed: true, reconciled: true });
		reopened.setEmergencyStop(false, "operator");
		reopened.close();
	});

	test("rolls back a publication set invalidated between authorization checks", () => {
		const database = new BackgroundAgentsDatabase(":memory:");
		const caseId = database.createCase({ title: "publication race", source: "manual" });
		const jobId = database.createJob({ caseId, role: "investigator" });
		const claim = database.claimJob(jobId, "runner")!;
		assert.throws(
			() =>
				database.withAttemptPublication(claim.attemptId, claim.stopEpoch, () => {
					database.run("UPDATE attempts SET publish_invalidated = 1 WHERE id = ?", claim.attemptId);
					database.createArtifact({ caseId, attemptId: claim.attemptId, kind: "stale-output" });
				}),
			/invalidated/,
		);
		assert.equal(database.get<{ count: number }>("SELECT count(*) AS count FROM artifacts")?.count, 0);
		database.close();
	});
});
