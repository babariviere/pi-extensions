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
});
