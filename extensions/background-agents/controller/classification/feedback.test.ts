import assert from "node:assert/strict";
import { test } from "node:test";
import { BackgroundAgentsDatabase } from "../database.ts";
import { activatePolicyRevision, recordOperatorFeedback, rollbackPolicy } from "./feedback.ts";
import { approvedClassifierExamples } from "./memory.ts";

test("records explicit operator corrections as retrievable approved examples", () => {
	const database = new BackgroundAgentsDatabase(":memory:");
	const caseId = database.createCase({ title: "Question", source: "slack" });
	const classificationId = database.insertClassification(caseId, {
		inputKind: "question",
		disposition: "ambiguous",
		actionability: 40,
		noise: 10,
		confidence: 40,
		rationale: "uncertain",
		policyVersion: "default",
		modelVersion: "model",
		influentialExamples: [],
	});
	const feedbackId = recordOperatorFeedback(database, {
		caseId,
		classificationId,
		action: "question-to-bug",
		actor: "operator",
		rationale: "operator supplied missing reproduction details",
	});
	const examples = approvedClassifierExamples(database);
	assert.equal(examples[0]?.id, feedbackId);
	assert.equal(examples[0]?.correction.inputKind, "bug-report");
	assert.equal(examples[0]?.correction.disposition, "actionable");
	assert.equal("body" in examples[0]?.correction, false);
	assert.throws(
		() => recordOperatorFeedback(database, { caseId, action: "dismiss-noise", actor: "agent:one" }),
		/explicit human/,
	);
	database.close();
});

test("requires a human to activate policies and supports explicit rollback", () => {
	const database = new BackgroundAgentsDatabase(":memory:");
	const first = database.createPolicy({ scope: "source:slack", version: "1", policy: {}, proposedBy: "agent:one" });
	const second = database.createPolicy({ scope: "source:slack", version: "2", policy: {}, proposedBy: "agent:two" });
	assert.throws(() => activatePolicyRevision(database, first, "agent:one"), /human/);
	activatePolicyRevision(database, first, "operator");
	activatePolicyRevision(database, second, "operator");
	assert.equal(database.getActivePolicy("source:slack")?.version, "2");
	rollbackPolicy(database, { scope: "source:slack", version: "1", actor: "operator" });
	assert.equal(database.getActivePolicy("source:slack")?.version, "1");
	assert.equal(database.getPolicy("source:slack", "2")?.status, "retired");
	database.close();
});
