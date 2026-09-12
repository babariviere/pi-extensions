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

test("controller persists and classifies manual intake in observe mode without mutating work", async () => {
	const database = new BackgroundAgentsDatabase(":memory:");
	databases.push(database);
	const controller = new BackgroundAgentsController({ database, startSocket: false });
	const response = await controller.handle({
		version: 1,
		id: "submit",
		type: "case.submit",
		source: "manual",
		title: "Bug",
		body: "It fails",
	});
	assert.equal(response.ok, true);
	await new Promise((resolve) => setTimeout(resolve, 10));
	const snapshot = controller.snapshot();
	assert.equal(snapshot.cases.length, 1);
	assert.equal(snapshot.cases[0]?.state, "classified");
	assert.equal(database.get<{ count: number }>("SELECT count(*) AS count FROM jobs")?.count, 0);
});

test("supervised intake queues investigation but cannot dispatch worker work before approval", async () => {
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
	assert.equal(database.get<{ role: string }>("SELECT role FROM jobs LIMIT 1")?.role, "investigator");
	assert.equal(controller.snapshot().cases[0]?.state, "investigating");
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
	assert.equal(database.get<{ state: string }>("SELECT state FROM jobs WHERE id = ?", jobId)?.state, "paused");

	const second = new BackgroundAgentsController({ database, startSocket: false, operator: "operator" });
	assert.equal(second.snapshot().emergencyStop, true);
	assert.equal(second.snapshot().rollout, "supervised");
	assert.equal(database.get<{ count: number }>("SELECT count(*) AS count FROM operator_events")?.count, 3);
	const resumed = await second.handle({ version: 1, id: "resume-stop", type: "emergency.stop", enabled: false });
	assert.equal(resumed.ok, true);
	assert.equal(second.snapshot().emergencyStop, false);
});
