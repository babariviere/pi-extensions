import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { BackgroundAgentsDatabase } from "./database.ts";
import { normalizeBackgroundAgentsConfig } from "../config.ts";
import { BackgroundAgentsController } from "./controller.ts";

const databases: BackgroundAgentsDatabase[] = [];
afterEach(() => {
	for (const database of databases.splice(0)) database.close();
});

test("controller persists manual intake and queues durable classification in observe mode", async () => {
	const database = new BackgroundAgentsDatabase(":memory:");
	databases.push(database);
	const controller = new BackgroundAgentsController({ database, startSocket: false });
	const response = await controller.handle({
		version: 1,
		id: "submit",
		type: "case.submit",
		source: "manual",
		sourceKey: "stable",
		title: "Bug",
		body: "It fails",
	});
	assert.equal(response.ok, true);
	await new Promise((resolve) => setTimeout(resolve, 10));
	const snapshot = controller.snapshot();
	assert.equal(snapshot.cases.length, 1);
	assert.equal(snapshot.cases[0]?.state, "intake");
	assert.equal(database.get<{ role: string }>("SELECT role FROM jobs")?.role, "classifier");
});

test("usage refresh pauses an active run even when runtime termination fails", async () => {
	const database = new BackgroundAgentsDatabase(":memory:");
	databases.push(database);
	const config = normalizeBackgroundAgentsConfig({
		profiles: [{ id: "usage-profile", provider: "anthropic", agentDir: process.cwd(), allowedModels: ["model"] }],
	});
	const caseId = database.createCase({ title: "usage termination", source: "manual" });
	database.transitionCase(caseId, "classified", "test");
	database.run("UPDATE cases SET state = 'implementation' WHERE id = ?", caseId);
	database.upsertProviderProfileState({ profileId: "usage-profile" });
	const jobId = database.createJob({ caseId, role: "worker" });
	const attempt = database.claimJob(jobId, "controller", 60_000, new Date(), {
		profileId: "usage-profile",
		model: "model",
	});
	assert.ok(attempt);
	database.run(
		"UPDATE attempts SET systemd_unit = ?, pane_id = ?, worktree = ? WHERE id = ?",
		"usage-unit",
		"usage-pane",
		"/preserved/worktree",
		attempt.attemptId,
	);
	const controller = new BackgroundAgentsController({
		database,
		config,
		startSocket: false,
		runtimeControls: {
			terminateSystemdUnit: async () => {
				throw new Error("termination failed");
			},
			isSystemdUnitStopped: async () => false,
			closePane: async () => {
				throw new Error("pane close failed");
			},
		},
	});
	await controller.start();
	await controller.stop();
	assert.equal(
		database.get<{ state: string }>("SELECT state FROM attempts WHERE id = ?", attempt.attemptId)?.state,
		"paused",
	);
	assert.equal(database.get<{ state: string }>("SELECT state FROM jobs WHERE id = ?", jobId)?.state, "paused");
	assert.equal(database.get<{ state: string }>("SELECT state FROM cases WHERE id = ?", caseId)?.state, "paused-usage");
	assert.equal(
		database.get<{ worktree: string }>("SELECT worktree FROM attempts WHERE id = ?", attempt.attemptId)?.worktree,
		"/preserved/worktree",
	);
});

test("supervised intake queues classification before investigation", async () => {
	const database = new BackgroundAgentsDatabase(":memory:");
	databases.push(database);
	const config = normalizeBackgroundAgentsConfig({ rollout: { defaultMode: "supervised" } });
	const controller = new BackgroundAgentsController({ database, config, startSocket: false });
	await controller.handle({
		version: 1,
		id: "submit",
		type: "case.submit",
		source: "manual",
		title: "Bug",
		body: "It fails",
	});
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(database.get<{ role: string }>("SELECT role FROM jobs LIMIT 1")?.role, "classifier");
	assert.equal(controller.snapshot().cases[0]?.state, "intake");
});

test("duplicate delivery and controller restart reconcile one classifier job", async () => {
	const database = new BackgroundAgentsDatabase(":memory:");
	databases.push(database);
	const controller = new BackgroundAgentsController({ database, startSocket: false, sources: [] });
	const first = await controller.handle({
		version: 1,
		id: "first",
		type: "case.submit",
		source: "manual",
		sourceKey: "stable",
		title: "Bug",
		body: "It fails",
	});
	assert.equal(first.ok, true);
	const second = await controller.handle({
		version: 1,
		id: "second",
		type: "case.submit",
		source: "manual",
		sourceKey: "stable",
		title: "Bug",
		body: "It fails",
	});
	assert.equal(second.ok, true);
	assert.equal(
		database.get<{ count: number }>("SELECT count(*) AS count FROM jobs WHERE role = 'classifier'")?.count,
		1,
	);
	await controller.start();
	await controller.stop();
	assert.equal(
		database.get<{ count: number }>("SELECT count(*) AS count FROM jobs WHERE role = 'classifier'")?.count,
		1,
	);
	const intake = database.createCase({ title: "Restart intake", source: "manual" });
	assert.equal(database.reconcileClassifierJobs().length, 2);
	assert.equal(database.reconcileClassifierJobs().length, 2);
	assert.equal(
		database.get<{ count: number }>("SELECT count(*) AS count FROM jobs WHERE case_id = ?", intake)?.count,
		1,
	);
});

test("classifier failures retry only after backoff and eventually block intake", async () => {
	const database = new BackgroundAgentsDatabase(":memory:");
	databases.push(database);
	let now = new Date("2026-01-01T00:00:00.000Z");
	const config = normalizeBackgroundAgentsConfig({
		profiles: [{ id: "classifier-profile", provider: "anthropic", agentDir: process.cwd() }],
		classifier: { maxAttempts: 3, retryBackoffMs: 1_000 },
	});
	const controller = new BackgroundAgentsController({
		database,
		config,
		startSocket: false,
		clock: () => now,
		attemptRunner: { run: async () => ({ state: "failed" as const, failure: "classifier unavailable" }) },
	});
	const response = await controller.handle({
		version: 1,
		id: "failure",
		type: "case.submit",
		source: "manual",
		title: "Bug",
		body: "It fails",
	});
	assert.equal(response.ok, true);
	const jobId = database.get<{ id: string }>("SELECT id FROM jobs WHERE role = 'classifier'")?.id;
	assert.ok(jobId);
	const tick = () => (controller as unknown as { schedulerTick(): Promise<void> }).schedulerTick();
	await tick();
	assert.deepEqual(
		database
			.all<{ generation: number; state: string }>("SELECT generation, state FROM attempts ORDER BY generation")
			.map((row) => ({ ...row })),
		[{ generation: 1, state: "failed" }],
	);
	await tick();
	assert.equal(database.get<{ state: string }>("SELECT state FROM jobs WHERE id = ?", jobId)?.state, "failed");
	assert.equal(
		database.get<{ count: number }>("SELECT count(*) AS count FROM attempts WHERE job_id = ?", jobId)?.count,
		1,
	);
	now = new Date("2026-01-01T00:00:01.000Z");
	await tick();
	assert.equal(
		database.get<{ generation: number; state: string }>(
			"SELECT generation, state FROM attempts WHERE job_id = ? AND generation = 2",
			jobId,
		)?.state,
		"failed",
	);
	now = new Date("2026-01-01T00:00:02.000Z");
	await tick();
	assert.equal(
		database.get<{ generation: number; state: string }>(
			"SELECT generation, state FROM attempts WHERE job_id = ? AND generation = 3",
			jobId,
		)?.state,
		"failed",
	);
	now = new Date("2026-01-01T00:00:03.000Z");
	await tick();
	assert.equal(database.get<{ state: string }>("SELECT state FROM jobs WHERE id = ?", jobId)?.state, "needs-human");
	assert.equal(database.get<{ state: string }>("SELECT state FROM cases LIMIT 1")?.state, "blocked");
	assert.match(
		database.get<{ reason: string }>("SELECT reason FROM case_events WHERE to_state = 'blocked'")?.reason ?? "",
		/classifier retry budget exhausted/,
	);
});

test("classifier retry generations and queued work survive controller restart", async () => {
	const root = mkdtempSync(join(tmpdir(), "background-agents-retry-"));
	const path = join(root, "controller.sqlite");
	try {
		let now = new Date("2026-01-01T00:00:00.000Z");
		const config = normalizeBackgroundAgentsConfig({
			profiles: [{ id: "classifier-profile", provider: "anthropic", agentDir: process.cwd() }],
			classifier: { maxAttempts: 2, retryBackoffMs: 1_000 },
		});
		const firstDatabase = new BackgroundAgentsDatabase(path);
		databases.push(firstDatabase);
		const firstController = new BackgroundAgentsController({
			database: firstDatabase,
			config,
			startSocket: false,
			clock: () => now,
			attemptRunner: { run: async () => ({ state: "failed" as const, failure: "temporary classifier outage" }) },
		});
		await firstController.handle({
			version: 1,
			id: "restart-failure",
			type: "case.submit",
			source: "manual",
			title: "Bug",
			body: "It fails",
		});
		await (firstController as unknown as { schedulerTick(): Promise<void> }).schedulerTick();
		now = new Date("2026-01-01T00:00:01.000Z");
		firstDatabase.reconcileClassifierRetries(2, 1_000, now);
		firstDatabase.close();
		const reopened = new BackgroundAgentsDatabase(path);
		databases.push(reopened);
		const restarted = new BackgroundAgentsController({
			database: reopened,
			config,
			startSocket: false,
			clock: () => now,
		});
		await restarted.start();
		await restarted.stop();
		assert.equal(
			reopened.get<{ state: string }>("SELECT state FROM jobs WHERE role = 'classifier'")?.state,
			"queued",
		);
		assert.deepEqual(
			reopened
				.all<{ generation: number; state: string }>("SELECT generation, state FROM attempts ORDER BY generation")
				.map((row) => ({ ...row })),
			[
				{ generation: 1, state: "failed" },
				{ generation: 2, state: "queued" },
			],
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("dispatches real Linear investigation through the durable start effect", async () => {
	const database = new BackgroundAgentsDatabase(":memory:");
	databases.push(database);
	const started: Array<{ phase: string; issueId: string }> = [];
	const config = normalizeBackgroundAgentsConfig({
		profiles: [{ id: "profile", provider: "anthropic", agentDir: process.cwd() }],
	});
	const controller = new BackgroundAgentsController({
		database,
		config,
		startSocket: false,
		linearEffects: {
			startWork: async ({ issue, phase }) => {
				started.push({ phase, issueId: issue.id });
				return { status: "started", issueId: issue.id, state: issue.state };
			},
		},
		attemptRunner: { run: async () => ({ state: "succeeded" as const }) },
	});
	const caseId = database.createCase({
		id: "linear-dispatch",
		title: "Linear work",
		source: "linear",
		repository: "repo",
	});
	database.transitionCase(caseId, "classified", "test");
	database.transitionCase(caseId, "investigating", "test");
	database.recordSourceEvent(
		{
			source: "linear",
			sourceKey: "linear:issue-1",
			revision: "revision-1",
			receivedAt: new Date().toISOString(),
			title: "ENG-1: Linear work",
			body: "Investigate",
			metadata: {
				state: { id: "todo", name: "Todo", type: "unstarted" },
				team: { id: "team-1", key: "ENG" },
			},
		},
		{ caseId },
	);
	const jobId = database.createJob({ caseId, role: "investigator" });
	await (controller as unknown as { schedulerTick(): Promise<void> }).schedulerTick();
	assert.deepEqual(started, [{ phase: "investigation", issueId: "issue-1" }]);
	assert.equal(database.get<{ state: string }>("SELECT state FROM jobs WHERE id = ?", jobId)?.state, "succeeded");
});

test("controller rejects insecure source credentials before reading them", () => {
	const root = mkdtempSync(join(tmpdir(), "background-agents-controller-credentials-"));
	try {
		const credentialPath = join(root, "datadog.json");
		writeFileSync(credentialPath, "not-json secret");
		chmodSync(credentialPath, 0o640);
		const ownerUid = lstatSync(credentialPath).uid;
		const config = normalizeBackgroundAgentsConfig({
			socket: { ownerUid },
			sources: { datadog: { enabled: true, credentialPath } },
		});
		const database = new BackgroundAgentsDatabase(":memory:");
		databases.push(database);
		assert.throws(
			() => new BackgroundAgentsController({ database, config, startSocket: false }),
			(error: unknown) => {
				assert.match(String(error), /group- or world-accessible/);
				assert.doesNotMatch(String(error), /secret/);
				return true;
			},
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("evidence reproduction requires an existing manifest owned by the selected case", async () => {
	const database = new BackgroundAgentsDatabase(":memory:");
	databases.push(database);
	const controller = new BackgroundAgentsController({ database, startSocket: false });
	const caseId = database.createCase({ title: "Evidence", source: "manual", repository: "/missing" });
	const otherCaseId = database.createCase({ title: "Other", source: "manual", repository: "/missing" });
	const response = await controller.handle({
		version: 1,
		id: "missing-manifest",
		type: "evidence.reproduce",
		caseId,
		manifestId: "does-not-exist",
	});
	assert.equal(response.ok, false);
	assert.equal(database.get<{ count: number }>("SELECT count(*) AS count FROM evidence_manifests")?.count, 0);
	const manifestId = database.createEvidenceManifest({
		caseId,
		manifest: {
			version: 1,
			baseSha: "base",
			candidateSha: "candidate",
			commands: [],
			createdAt: new Date().toISOString(),
		},
	});
	const wrongCase = await controller.handle({
		version: 1,
		id: "wrong-case",
		type: "evidence.reproduce",
		caseId: otherCaseId,
		manifestId,
	});
	assert.equal(wrongCase.ok, false);
	assert.equal(database.get<{ count: number }>("SELECT count(*) AS count FROM verification_runs")?.count, 0);
	const marker = join(tmpdir(), `background-replay-${Date.now()}-${Math.random()}`);
	const queuedManifest = database.createEvidenceManifest({
		caseId,
		manifest: {
			version: 1,
			baseSha: "base-sha",
			candidateSha: "candidate-sha",
			createdAt: new Date().toISOString(),
			commands: [
				{
					executable: process.execPath,
					argv: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed")`],
					cwd: ".",
					timeoutMs: 1000,
					environment: [],
					phase: "candidate",
					purpose: "acceptance",
					expected: { exitCode: 0 },
				},
			],
		},
	});
	const queued = await controller.handle({
		version: 1,
		id: "queue-reproduction",
		type: "evidence.reproduce",
		caseId,
		manifestId: queuedManifest,
	});
	assert.equal(queued.ok, true);
	assert.equal(typeof (queued as { result?: { jobId?: string } }).result?.jobId, "string");
	assert.equal(database.get<{ count: number }>("SELECT count(*) AS count FROM verification_runs")?.count, 0);
	assert.equal(
		database.get<{ count: number }>("SELECT count(*) AS count FROM jobs WHERE role = 'verifier'")?.count,
		1,
	);
	assert.throws(() => lstatSync(marker), /ENOENT/);
});

test("restores durable controls across controller restart and reconciles an emergency stop", async () => {
	const database = new BackgroundAgentsDatabase(":memory:");
	databases.push(database);
	const calls: string[] = [];
	const runtimeControls = {
		terminateSystemdUnit: async (unit: string) => {
			calls.push(`stop:${unit}`);
		},
		isSystemdUnitStopped: async (unit: string) => {
			calls.push(`inspect:${unit}`);
			return true;
		},
		closePane: async (pane: string) => {
			calls.push(`close:${pane}`);
		},
	};
	const first = new BackgroundAgentsController({
		database,
		startSocket: false,
		runtimeControls,
		operator: "operator",
	});
	const caseId = database.createCase({ title: "Running", source: "manual" });
	const jobId = database.createJob({ caseId, role: "investigator" });
	const claim = database.claimJob(jobId, "runner", 60_000);
	assert.ok(claim);
	database.run(
		"UPDATE attempts SET systemd_unit = ?, pane_id = ? WHERE id = ?",
		"background-agent-test",
		"pane-test",
		claim?.attemptId,
	);
	await first.handle({ version: 1, id: "rollout", type: "rollout.set", scope: "global", value: "supervised" });
	const stopped = await first.handle({ version: 1, id: "stop", type: "emergency.stop", enabled: true });
	assert.equal(stopped.ok, true);
	assert.deepEqual(calls, ["stop:background-agent-test", "inspect:background-agent-test", "close:pane-test"]);
	assert.equal(database.get<{ state: string }>("SELECT state FROM jobs WHERE id = ?", jobId)?.state, "needs-human");

	const second = new BackgroundAgentsController({
		database,
		startSocket: false,
		operator: "operator",
		runtimeControls,
	});
	assert.equal(second.snapshot().emergencyStop, true);
	assert.equal(second.snapshot().rollout, "supervised");
	assert.equal(database.get<{ count: number }>("SELECT count(*) AS count FROM operator_events")?.count, 3);
	const resumed = await second.handle({ version: 1, id: "resume-stop", type: "emergency.stop", enabled: false });
	assert.equal(resumed.ok, true);
	assert.equal(second.snapshot().emergencyStop, false);
});

test("emergency stop attempts every unit and pane, pauses jobs, reconciles every attempt, and aggregates failures", async () => {
	const database = new BackgroundAgentsDatabase(":memory:");
	databases.push(database);
	const stopped: string[] = [];
	const closed: string[] = [];
	const reconciled: string[] = [];
	const attempts: string[] = [];
	const runtimeControls = {
		terminateSystemdUnit: async (unit: string) => {
			stopped.push(unit);
			if (unit === "unit-one") throw new Error("stop-one");
		},
		isSystemdUnitStopped: async () => true,
		closePane: async (pane: string) => {
			closed.push(pane);
			if (pane === "pane-one") throw new Error("close-one");
		},
	};
	const controller = new BackgroundAgentsController({
		database,
		startSocket: false,
		runtimeControls,
		recovery: {
			reconcileAttempt: async (attemptId) => {
				reconciled.push(attemptId);
				return { attemptId, action: "needs-human", systemdState: "unknown", reason: "paused" };
			},
		},
	});
	for (const [unit, pane] of [
		["unit-one", "pane-one"],
		["unit-two", "pane-two"],
	]) {
		const caseId = database.createCase({ title: unit, source: "manual" });
		const jobId = database.createJob({ caseId, role: "investigator" });
		const claim = database.claimJob(jobId, "runner", 60_000)!;
		database.run("UPDATE attempts SET systemd_unit = ?, pane_id = ? WHERE id = ?", unit, pane, claim.attemptId);
		attempts.push(claim.attemptId);
	}
	const response = await controller.handle({ version: 1, id: "stop-all", type: "emergency.stop", enabled: true });
	assert.equal(response.ok, false);
	assert.match((response as { error?: { message?: string } }).error?.message ?? "", /stop-one/);
	assert.match((response as { error?: { message?: string } }).error?.message ?? "", /close-one/);
	assert.deepEqual(stopped.sort(), ["unit-one", "unit-two"]);
	assert.deepEqual(closed.sort(), ["pane-one", "pane-two"]);
	assert.deepEqual(reconciled.sort(), attempts.sort());
	assert.equal(database.get<{ count: number }>("SELECT count(*) AS count FROM jobs WHERE state = 'paused'")?.count, 2);
});

test("failed worker attempts are reconciled before the controller terminalizes them", async () => {
	const database = new BackgroundAgentsDatabase(":memory:");
	databases.push(database);
	const caseId = database.createCase({ title: "failed worker", source: "manual" });
	database.run("UPDATE cases SET state = 'implementation', rollout_mode = 'supervised' WHERE id = ?", caseId);
	const jobId = database.createJob({ caseId, role: "worker" });
	const reconciled: string[] = [];
	const controller = new BackgroundAgentsController({
		database,
		startSocket: false,
		config: normalizeBackgroundAgentsConfig({
			rollout: { defaultMode: "supervised" },
			profiles: [{ id: "profile", provider: "anthropic", agentDir: process.cwd() }],
		}),
		attemptRunner: { run: async (claim) => ({ state: "failed", failure: "unit failed" }) },
		recovery: {
			reconcileAttempt: async (attemptId) => {
				reconciled.push(attemptId);
				return { attemptId, action: "needs-human", systemdState: "failed", reason: "dirty worktree" };
			},
		},
	});
	const usage = (controller as unknown as { providerScheduler: { usage: { states: Map<string, unknown> } } })
		.providerScheduler.usage;
	usage.states.set("profile", {
		profileId: "profile",
		provider: "anthropic",
		observedAt: new Date(),
		windows: [{ label: "test", usedPercent: 0 }],
		available: true,
	});
	await (controller as unknown as { schedulerTick(): Promise<void> }).schedulerTick();
	assert.equal(reconciled.length, 1);
	assert.equal(
		database.get<{ state: string }>("SELECT state FROM attempts WHERE job_id = ?", jobId)?.state,
		"running",
	);
});
