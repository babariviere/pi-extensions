import assert from "node:assert/strict";
import { test } from "node:test";
import { BackgroundAgentsDatabase } from "../database.ts";
import { Classifier, applyThresholds } from "./classifier.ts";
import { recordOperatorFeedback, activatePolicyRevision } from "./feedback.ts";

function event(sourceKey: string, caseId?: string) {
	return {
		source: "datadog" as const,
		sourceKey,
		revision: "1",
		receivedAt: "2026-01-01T00:00:00Z",
		title: "checkout timeout",
		body: `payload for ${caseId ?? sourceKey}`,
		service: "checkout",
		fingerprint: "timeout-fingerprint",
		metadata: { monitor: "checkout-timeout", environment: "production" },
	};
}

test("applies actionable, noise, and ambiguous threshold bands", () => {
	const thresholds = { actionableMin: 70, noiseMax: 30 };
	assert.equal(
		applyThresholds(
			{ inputKind: "error", actionability: 90, noise: 10, confidence: 90, rationale: "clear" },
			thresholds,
		),
		"actionable",
	);
	assert.equal(
		applyThresholds(
			{ inputKind: "other", actionability: 10, noise: 90, confidence: 90, rationale: "irrelevant" },
			thresholds,
		),
		"noise",
	);
	assert.equal(
		applyThresholds(
			{ inputKind: "bug-report", actionability: 60, noise: 20, confidence: 60, rationale: "uncertain" },
			thresholds,
		),
		"ambiguous",
	);
});

test("launches without tools, requires structured output, and stores versioned immutable classification", async () => {
	const database = new BackgroundAgentsDatabase(":memory:");
	const oldCase = database.createCase({ title: "Old timeout", source: "datadog" });
	const oldEvent = database.recordSourceEvent(event("old-monitor-event", oldCase), { caseId: oldCase });
	const oldClassification = database.insertClassification(oldCase, {
		inputKind: "error",
		disposition: "actionable",
		actionability: 90,
		noise: 5,
		confidence: 90,
		rationale: "operator-confirmed",
		fingerprint: "old-fingerprint",
		policyVersion: "policy-1",
		modelVersion: "model-1",
		influentialExamples: [],
	});
	recordOperatorFeedback(database, {
		caseId: oldCase,
		classificationId: oldClassification,
		action: "reclassify",
		inputKind: "error",
		actor: "operator",
	});
	const current = database.recordSourceEvent(event("current-event"));
	const policyId = database.createPolicy({
		scope: "service:checkout",
		version: "policy-2",
		policy: { thresholds: { actionableMin: 80, noiseMax: 20 } },
		proposedBy: "agent:classifier",
	});
	activatePolicyRevision(database, policyId, "operator");
	let request: unknown;
	const result = await new Classifier({
		database,
		modelVersion: "model-2",
		launch: async (value) => {
			request = value;
			return { inputKind: "error", actionability: 85, noise: 10, confidence: 90, rationale: "current evidence" };
		},
	}).classify(current.caseId, event("current-event"));
	const launch = request as {
		tools: readonly unknown[];
		structuredOutput: boolean;
		policyVersion: string;
		examples: readonly { id: string }[];
	};
	assert.deepEqual(launch.tools, []);
	assert.equal(launch.structuredOutput, true);
	assert.equal(launch.policyVersion, "policy-2");
	assert.deepEqual(
		launch.examples.map((example) => example.id),
		[database.get<{ id: string }>("SELECT id FROM feedback")?.id],
	);
	assert.equal(result.classification.disposition, "actionable");
	assert.equal(result.classification.modelVersion, "model-2");
	assert.equal(result.classification.policyVersion, "policy-2");
	assert.equal(database.get<{ count: number }>("SELECT count(*) AS count FROM memory_entries")?.count, 0);
	assert.throws(() => database.exec("UPDATE classifications SET rationale = 'changed'"), /immutable/);
	assert.equal(oldEvent.caseId, oldCase);
	database.close();
});

test("rejects non-structured classifier output", async () => {
	const database = new BackgroundAgentsDatabase(":memory:");
	const current = database.recordSourceEvent(event("invalid-output"));
	await assert.rejects(
		new Classifier({ database, modelVersion: "model", launch: async () => ({ inputKind: "error" }) }).classify(
			current.caseId,
			event("invalid-output"),
		),
		/number between 0 and 100/,
	);
	database.close();
});
