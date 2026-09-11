import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, test } from "node:test";
import { normalizeBackgroundAgentsConfig } from "../../config.ts";
import { BackgroundAgentsDatabase } from "../database.ts";
import { ProfileUsageController } from "./usage.ts";
import { ProviderScheduler } from "./scheduler.ts";
import type { ProviderProfile } from "../../types.ts";

const directories: string[] = [];
function setup() {
	const directory = mkdtempSync(join(tmpdir(), "background-agents-scheduler-"));
	directories.push(directory);
	const database = new BackgroundAgentsDatabase(join(directory, "controller.sqlite"));
	const config = normalizeBackgroundAgentsConfig({
		profiles: [
			{ id: "claude", provider: "anthropic", agentDir: directory, allowedModels: ["claude"] },
			{ id: "openai", provider: "openai", agentDir: directory, allowedModels: ["codex"] },
		],
	});
	return { database, config };
}
function collector() {
	return async (profile: ProviderProfile) => ({
		profileId: profile.id,
		provider: profile.provider,
		windows: [{ label: "Week", usedPercent: 10 }],
	});
}
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("provider-aware scheduling", () => {
	test("uses one attempt per profile and chooses another provider for verification", async () => {
		const { database, config } = setup();
		const usage = new ProfileUsageController(database, config.profiles, { collector: collector() });
		const at = new Date("2026-01-01T00:00:00Z");
		await usage.refresh(at);
		const scheduler = new ProviderScheduler(database, config, { usage });
		const caseId = database.createCase({ title: "provider routing", source: "manual" });
		const workerJob = database.createJob({ caseId, role: "worker" });
		const worker = scheduler.claim(workerJob, "controller", 1000, at);
		assert.equal(worker?.profileId, "claude");
		const verifierJob = database.createJob({ caseId, role: "verifier" });
		const verifier = scheduler.claim(verifierJob, "controller", 1000, new Date(at.getTime() + 1));
		assert.equal(verifier?.profileId, "openai");
		database.close();
	});

	test("routes cheap classification without requiring a fresh usage snapshot", () => {
		const { database, config } = setup();
		const scheduler = new ProviderScheduler(database, config);
		const caseId = database.createCase({ title: "cheap", source: "manual" });
		const jobId = database.createJob({ caseId, role: "classifier" });
		assert.equal(scheduler.claim(jobId, "controller")?.profileId, "claude");
		database.close();
	});

	test("pauses usage-exhausted attempts and resumes as a new generation", async () => {
		const { database, config } = setup();
		const usage = new ProfileUsageController(database, config.profiles, { collector: collector() });
		const at = new Date("2026-01-01T00:00:00Z");
		await usage.refresh(at);
		const scheduler = new ProviderScheduler(database, config, { usage });
		const caseId = database.createCase({ title: "pause", source: "manual" });
		const jobId = database.createJob({ caseId, role: "worker" });
		const first = scheduler.claim(jobId, "controller", 1000, at)!;
		assert.equal(scheduler.pauseForUsage(first.attemptId, "quota exhausted", new Date(at.getTime() + 1)), true);
		assert.equal(
			database.get<{ state: string }>("SELECT state FROM attempts WHERE id = ?", first.attemptId)?.state,
			"paused",
		);
		assert.equal(scheduler.resumeAfterUsage(jobId), true);
		const replacement = scheduler.claim(jobId, "controller", 1000, new Date(at.getTime() + 2));
		assert.equal(replacement?.generation, 2);
		assert.notEqual(replacement?.attemptId, first.attemptId);
		database.close();
	});
});
