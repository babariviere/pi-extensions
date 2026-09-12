import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { BackgroundAgentsDatabase } from "../database.ts";
import { BackgroundAgentsStateMachine } from "../state-machine.ts";
import { approveMemoryEntry, createMemoryEntry } from "../classification/memory.ts";
import {
	buildInvestigationContext,
	retrieveFullCase,
	InvestigationWorkflow,
	QuickFixWorkflow,
} from "./investigation.ts";
import { buildQuestionContext, QuestionWorkflow } from "./question.ts";
import { SpecificationWorkflow } from "./specification.ts";

const directories: string[] = [];
function databasePath(): string {
	const directory = mkdtempSync(join(tmpdir(), "background-agents-workflows-"));
	directories.push(directory);
	return join(directory, "controller.sqlite");
}
function classified(database: BackgroundAgentsDatabase, title: string, body = title): string {
	const caseId = database.createCase({ title, source: "manual" });
	database.recordSourceEvent(
		{ source: "manual", sourceKey: `${title}-source`, receivedAt: new Date().toISOString(), title, body },
		{ caseId },
	);
	const eventCase = database.get<{ case_id: string }>(
		"SELECT case_id FROM source_events WHERE source_key = ?",
		`${title}-source`,
	);
	assert.equal(eventCase?.case_id, caseId);
	database.transitionCase(caseId, "classified", "test");
	return caseId;
}

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("background-agent workflows", () => {
	test("quick-fix candidates use one bounded item and rollout-specific admission", () => {
		const database = new BackgroundAgentsDatabase(databasePath());
		const autonomous = classified(database, "autonomous");
		database.run("UPDATE cases SET repository = ?, rollout_mode = 'autonomous-pr' WHERE id = ?", "repo", autonomous);
		const output = {
			autonomy: "quick-fix-candidate" as const,
			findings: "bounded finding",
			scope: "one function",
			risks: ["regression"],
			verificationPlan: ["run focused test"],
			confidence: 99,
			uncertainties: [],
		};
		const admitted = new QuickFixWorkflow(database).admit(autonomous, output, "autonomous-pr");
		assert.equal(
			database.get<{ count: number }>("SELECT count(*) AS count FROM work_items WHERE case_id = ?", autonomous)
				?.count,
			1,
		);
		assert.equal(
			database.get<{ role: string }>("SELECT role FROM jobs WHERE case_id = ?", autonomous)?.role,
			"worker",
		);
		assert.equal(admitted.decision, "approved");

		const supervised = classified(database, "supervised");
		database.run("UPDATE cases SET repository = ?, rollout_mode = 'supervised' WHERE id = ?", "repo", supervised);
		const pending = new QuickFixWorkflow(database).admit(supervised, output, "supervised");
		assert.equal(pending.decision, "pending");
		assert.equal(
			database.get<{ count: number }>("SELECT count(*) AS count FROM jobs WHERE case_id = ?", supervised)?.count,
			0,
		);
		new QuickFixWorkflow(database).approve(supervised, "operator");
		assert.equal(
			database.get<{ role: string }>("SELECT role FROM jobs WHERE case_id = ?", supervised)?.role,
			"worker",
		);

		const unmapped = classified(database, "unmapped");
		const needsHuman = new QuickFixWorkflow(database).admit(unmapped, output, "autonomous-pr");
		assert.equal(needsHuman.decision, "needs-human");
		assert.equal(
			database.get<{ count: number }>("SELECT count(*) AS count FROM jobs WHERE case_id = ?", unmapped)?.count,
			0,
		);
		assert.equal(database.get<{ state: string }>("SELECT state FROM cases WHERE id = ?", unmapped)?.state, "blocked");
		database.close();
	});
	test("investigation includes current evidence and bounded related summaries, with full retrieval explicit", () => {
		const database = new BackgroundAgentsDatabase(databasePath());
		const prior = classified(database, "prior", "old evidence");
		const memory = createMemoryEntry(database, {
			caseId: prior,
			finding: "The cache key was stale",
			rootCause: "old root cause",
			evidenceSummary: "old evidence summary",
			confidence: 80,
			scope: "service",
		});
		approveMemoryEntry(database, memory, "operator");
		const current = classified(database, "current", "new evidence");
		const context = buildInvestigationContext(database, current, 4);
		assert.equal(context.currentEvidence[0]?.body, "new evidence");
		assert.deepEqual(context.capabilities.fullCaseRetrieval, "explicit");
		assert.equal(context.relatedCases.length, 0);
		const full = retrieveFullCase(database, prior);
		assert.equal(full.events[0]?.body, "old evidence");
		database.close();
	});

	test("question mode is bounded read-only and stores only a private brief", () => {
		const database = new BackgroundAgentsDatabase(databasePath());
		const caseId = classified(database, "question");
		const limits = { maxTimeMs: 1000, maxAttempts: 1, maxResults: 3 };
		const context = buildQuestionContext(database, caseId, "What happened?", limits);
		assert.equal(context.capabilities.mutations, false);
		assert.equal(context.capabilities.externalResponses, false);
		assert.throws(() => buildQuestionContext(database, caseId, "What happened?", limits, ["bash"]), /read-only/);
		const workflow = new QuestionWorkflow(database);
		const started = workflow.start(caseId, "What happened?", limits);
		workflow.record(
			caseId,
			"What happened?",
			{
				findings: "The event was transient.",
				sources: ["source-events"],
				confidence: 72,
				uncertainties: ["No live telemetry"],
			},
			limits,
		);
		assert.equal(database.get<{ state: string }>("SELECT state FROM cases WHERE id = ?", caseId)?.state, "handled");
		assert.equal(
			database.get<{ count: number }>("SELECT count(*) AS count FROM question_briefs WHERE case_id = ?", caseId)
				?.count,
			1,
		);
		assert.equal(database.get<{ count: number }>("SELECT count(*) AS count FROM external_effects")?.count, 0);
		assert.equal(database.get<{ id: string }>("SELECT id FROM jobs WHERE id = ?", started.jobId)?.id, started.jobId);
		database.close();
	});

	test("specification versions and feedback are durable, and approval freezes hash, permissions, and order", () => {
		const database = new BackgroundAgentsDatabase(databasePath());
		const caseId = classified(database, "specification");
		database.run("UPDATE cases SET rollout_mode = 'supervised' WHERE id = ?", caseId);
		const workflow = new SpecificationWorkflow(database);
		const started = workflow.start(caseId);
		const first = workflow.recordPlannerResult(caseId, {
			specification: { goal: "fix" },
			decisions: [{ decision: "use existing API" }],
			unresolvedQuestions: ["Which timeout?"],
			permissions: ["repository.read"],
			plannerSummary: "Initial plan",
			decomposition: [
				{ order: 1, title: "Implement fix", scope: "bounded fix", acceptanceCriteria: ["fix passes"] },
			],
		});
		assert.equal(first.version, 1);
		assert.equal(first.decomposition.length, 1);
		assert.equal(first.orderedWorkItems.length, 1);
		assert.equal(
			database.get<{ parent_id: string | null; spec_version_id: string }>(
				"SELECT parent_id, spec_version_id FROM work_items WHERE id = ?",
				first.orderedWorkItems[0],
			)?.parent_id,
			null,
		);
		const feedback = workflow.recordHumanFeedback(caseId, 1, "Use the shared timeout", "operator");
		assert.notEqual(feedback.attemptId, started.attemptId);
		assert.equal(feedback.context.latest?.version, 1);
		assert.equal(feedback.context.previousPlannerSummary, "Initial plan");
		assert.deepEqual(feedback.context.unresolvedQuestions, ["Which timeout?"]);
		assert.equal(
			database.get<{ count: number }>("SELECT count(*) AS count FROM attempts WHERE case_id = ?", caseId)?.count,
			2,
		);
		const second = workflow.recordPlannerResult(caseId, {
			specification: { goal: "fix", timeout: "shared" },
			decisions: [{ decision: "use existing API" }, { decision: "shared timeout" }],
			unresolvedQuestions: [],
			permissions: ["repository.read", "repository.test"],
			plannerSummary: "Updated plan",
			decomposition: [
				{
					order: 1,
					title: "Implement timeout fix",
					scope: "bounded timeout change",
					acceptanceCriteria: ["shared timeout is used"],
				},
			],
		});
		assert.equal(second.version, 2);
		const approval = workflow.approve(
			caseId,
			2,
			["repository.read", "repository.test"],
			"operator",
			second.orderedWorkItems,
		);
		const stored = database.get<{
			material_hash: string;
			spec_version: number;
			frozen_permissions: string;
			ordered_work_items: string;
		}>(
			"SELECT material_hash, spec_version, frozen_permissions, ordered_work_items FROM approvals WHERE id = ?",
			approval.approvalId,
		);
		assert.equal(stored?.material_hash, second.materialHash);
		assert.equal(stored?.spec_version, 2);
		assert.deepEqual(JSON.parse(stored?.frozen_permissions ?? "[]"), ["repository.read", "repository.test"]);
		assert.deepEqual(JSON.parse(stored?.ordered_work_items ?? "[]"), second.orderedWorkItems);
		assert.deepEqual(
			database
				.all<{ work_item_id: string }>("SELECT work_item_id FROM jobs WHERE role = 'worker' ORDER BY created_at")
				.map((row) => row.work_item_id),
			[second.orderedWorkItems[0]],
		);
		database.close();
	});

	test("supervised stacks require durable exact-item approval after parent verification", () => {
		const database = new BackgroundAgentsDatabase(databasePath());
		const caseId = classified(database, "supervised stack");
		database.run("UPDATE cases SET rollout_mode = 'supervised' WHERE id = ?", caseId);
		const workflow = new SpecificationWorkflow(database);
		workflow.start(caseId);
		const specification = workflow.recordPlannerResult(caseId, {
			specification: { goal: "stack" },
			decisions: [],
			unresolvedQuestions: [],
			permissions: [],
			plannerSummary: "stack",
			decomposition: [
				{ order: 1, title: "first", scope: "first", acceptanceCriteria: ["first passes"] },
				{ order: 2, title: "second", scope: "second", acceptanceCriteria: ["second passes"] },
			],
		});
		workflow.approve(caseId, specification.version, [], "operator", specification.orderedWorkItems);
		assert.equal(
			database.get<{ count: number }>("SELECT count(*) AS count FROM jobs WHERE role = 'worker'")?.count,
			1,
		);
		assert.throws(
			() => workflow.approveWorkItem(caseId, specification.orderedWorkItems[1]!, specification.version, "operator"),
			/out of order|Parent work item/,
		);
		workflow.queueNextWorker(caseId);
		assert.equal(
			database.get<{ count: number }>("SELECT count(*) AS count FROM jobs WHERE role = 'worker'")?.count,
			1,
		);
		const machine = new BackgroundAgentsStateMachine(database);
		machine.transitionWorkItem(specification.orderedWorkItems[0]!, "implementation", "worker");
		machine.transitionWorkItem(specification.orderedWorkItems[0]!, "verification", "worker");
		machine.transitionWorkItem(specification.orderedWorkItems[0]!, "verified", "verifier");
		const approval = workflow.approveWorkItem(
			caseId,
			specification.orderedWorkItems[1]!,
			specification.version,
			"operator",
		);
		assert.ok(approval.approvalId);
		assert.equal(database.get<{ count: number }>("SELECT count(*) AS count FROM work_item_approvals")?.count, 1);
		assert.equal(
			database.get<{ count: number }>(
				"SELECT count(*) AS count FROM jobs WHERE work_item_id = ?",
				specification.orderedWorkItems[1],
			)?.count,
			1,
		);
		assert.throws(
			() => workflow.approveWorkItem(caseId, specification.orderedWorkItems[1]!, specification.version, "operator"),
			/already running|approved/,
		);
		database.close();
	});
});
