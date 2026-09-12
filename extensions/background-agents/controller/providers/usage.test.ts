import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, test } from "node:test";
import { normalizeBackgroundAgentsConfig } from "../../config.ts";
import { BackgroundAgentsDatabase } from "../database.ts";
import { JobScheduler } from "../jobs.ts";
import { ProfileUsageController } from "./usage.ts";

const directories: string[] = [];

function setup() {
	const directory = mkdtempSync(join(tmpdir(), "background-agents-usage-"));
	directories.push(directory);
	const path = join(directory, "controller.sqlite");
	const database = new BackgroundAgentsDatabase(path);
	const config = normalizeBackgroundAgentsConfig({
		profiles: [
			{ id: "claude-work", provider: "anthropic", agentDir: directory, allowedModels: ["claude"] },
			{ id: "openai-work", provider: "openai", agentDir: directory, allowedModels: ["codex"] },
		],
	});
	return { database, config, path };
}

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("profile usage control", () => {
	test("collects and persists isolated profile usage, including both subscription providers", async () => {
		const { database, config } = setup();
		const calls: string[] = [];
		const usage = new ProfileUsageController(database, config.profiles, {
			clock: () => new Date("2026-01-01T00:00:00Z"),
			collector: async (profile) => {
				calls.push(profile.id);
				return {
					profileId: profile.id,
					provider: profile.provider,
					observedAt: "2026-01-01T00:00:00Z",
					windows: [{ label: "Week", usedPercent: profile.provider === "anthropic" ? 20 : 30 }],
				};
			},
		});
		await usage.refresh();
		assert.deepEqual(calls, ["claude-work", "openai-work"]);
		assert.equal(database.latestUsageSnapshots("claude-work").length, 1);
		assert.equal(database.latestUsageSnapshots("openai-work").length, 1);
		assert.equal(usage.canSchedule(config.profiles[0]!, "worker"), true);
		database.close();
	});

	test("allows cheap classification without usage but blocks stale expensive work", async () => {
		const { database, config } = setup();
		const now = new Date("2026-01-01T00:00:00Z");
		const usage = new ProfileUsageController(database, config.profiles, {
			clock: () => now,
			collector: async (profile) => ({
				profileId: profile.id,
				provider: profile.provider,
				observedAt: now,
				windows: [{ label: "5h", usedPercent: 40 }],
			}),
		});
		assert.equal(usage.canSchedule(config.profiles[0]!, "classifier"), true);
		assert.equal(usage.canSchedule(config.profiles[0]!, "worker"), false);
		await usage.refresh();
		assert.equal(usage.canSchedule(config.profiles[0]!, "worker"), true);
		assert.equal(usage.canSchedule(config.profiles[0]!, "worker", new Date("2026-01-01T00:20:00Z")), false);
		database.close();
	});

	test("does not consume the configured interactive reserve", async () => {
		const { database, config } = setup();
		const profile = { ...config.profiles[0]!, interactiveReserve: 2 };
		const usage = new ProfileUsageController(database, [profile], {
			collector: async () => ({
				provider: "anthropic" as const,
				windows: [{ label: "Week", usedPercent: 10 }],
				remaining: 2,
			}),
		});
		await usage.refresh();
		assert.equal(usage.canSchedule(profile, "worker"), false);
		database.close();
	});

	test("reconciles exhausted model attempts durably across refresh restart and preserves verifiers", async () => {
		const { database, config } = setup();
		const now = new Date("2026-01-01T00:00:00Z");
		const caseId = database.createCase({ title: "usage pause", source: "manual" });
		database.upsertProviderProfileState({ profileId: config.profiles[0]!.id });
		const workerJob = database.createJob({ caseId, role: "worker" });
		const worker = database.claimJob(workerJob, "controller", 1000, now, {
			profileId: config.profiles[0]!.id,
			model: "claude",
		})!;
		let reconciled = 0;
		const collector = async (profile: (typeof config.profiles)[number]) => ({
			profileId: profile.id,
			provider: profile.provider,
			windows: [{ label: "Week", usedPercent: 100 }],
			available: false,
			error: "quota exhausted",
		});
		const usage = new ProfileUsageController(database, config.profiles, {
			collector,
			reconcileAttempt: async (attempt, reason, observedAt) => {
				reconciled += 1;
				new JobScheduler(database).pauseAttemptForUsage(attempt.attemptId, reason, observedAt);
			},
		});
		await usage.refresh(now);
		assert.equal(reconciled, 1);
		assert.equal(
			database.get<{ state: string }>("SELECT state FROM attempts WHERE id = ?", worker.attemptId)?.state,
			"paused",
		);
		assert.equal(database.get<{ count: number }>("SELECT count(*) AS count FROM usage_paused_jobs")?.count, 1);
		assert.equal(database.attemptMayPublish(worker.attemptId, worker.stopEpoch), false);
		const verifierJob = database.createJob({ caseId, role: "verifier" });
		const verifier = database.claimJob(verifierJob, "controller", 1000, now, { profileId: config.profiles[0]!.id })!;
		const restarted = new ProfileUsageController(database, config.profiles, {
			collector,
			reconcileAttempt: async () => {
				reconciled += 1;
			},
		});
		await restarted.refresh(now);
		assert.equal(reconciled, 1);
		assert.equal(
			database.get<{ state: string }>("SELECT state FROM attempts WHERE id = ?", verifier.attemptId)?.state,
			"running",
		);
		database.close();
	});

	test("persists usage stop handles across restart and blocks resume until termination is confirmed", () => {
		const { database, config, path } = setup();
		const caseId = database.createCase({ title: "stop intent", source: "manual" });
		database.upsertProviderProfileState({ profileId: config.profiles[0]!.id });
		const jobId = database.createJob({ caseId, role: "worker" });
		const claim = database.claimJob(jobId, "controller", 1000, new Date(), {
			profileId: config.profiles[0]!.id,
			model: "claude",
		})!;
		database.run(
			"UPDATE attempts SET systemd_unit = ?, pane_id = ? WHERE id = ?",
			"usage-unit",
			"usage-pane",
			claim.attemptId,
		);
		database.pauseJobForUsage(claim.attemptId, "quota exhausted");
		assert.deepEqual(
			database.listPendingUsageStopIntents().map((intent) => ({
				attemptId: intent.attemptId,
				jobId: intent.jobId,
				profileId: intent.profileId,
				systemdUnit: intent.systemdUnit,
				paneId: intent.paneId,
				status: intent.status,
			})),
			[
				{
					attemptId: claim.attemptId,
					jobId,
					profileId: config.profiles[0]!.id,
					systemdUnit: "usage-unit",
					paneId: "usage-pane",
					status: "pending",
				},
			],
		);
		database.close();
		const reopened = new BackgroundAgentsDatabase(path);
		assert.equal(reopened.listPendingUsageStopIntents()[0]?.attemptId, claim.attemptId);
		assert.throws(() => reopened.resumeUsageJobs(caseId), /usage stop is pending/);
		reopened.markUsageStopIntent(claim.attemptId, { systemdConfirmed: true, paneConfirmed: true });
		assert.equal(reopened.listPendingUsageStopIntents().length, 0);
		reopened.close();
	});
});
