import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { BackgroundAgentsDatabase, IllegalCaseTransitionError } from "./database.ts";
import {
	BackgroundAgentsStateMachine,
	IllegalWorkItemTransitionError,
	SpecificationVersionMismatchError,
} from "./state-machine.ts";

const directories: string[] = [];

function databasePath(): string {
	const directory = mkdtempSync(join(tmpdir(), "background-agents-state-"));
	directories.push(directory);
	return join(directory, "controller.sqlite");
}

function awaitingApproval(database: BackgroundAgentsDatabase): string {
	const caseId = database.createCase({ title: "Lifecycle", source: "manual" });
	database.transitionCase(caseId, "classified", "test");
	database.transitionCase(caseId, "specification", "test");
	database.transitionCase(caseId, "awaiting-approval", "test");
	return caseId;
}

function addSpec(database: BackgroundAgentsDatabase, caseId: string, version: number): string {
	const id = `spec-${version}`;
	const itemId = `item-${version}`;
	database.run(
		"INSERT INTO spec_versions (id, case_id, version, specification, material_hash, decomposition, ordered_work_items) VALUES (?, ?, ?, ?, ?, ?, ?)",
		id,
		caseId,
		version,
		JSON.stringify({ version }),
		`hash-${version}`,
		JSON.stringify([{ order: 1, title: `item ${version}`, scope: "bounded", acceptanceCriteria: ["passes"] }]),
		JSON.stringify([itemId]),
	);
	database.run(
		"INSERT INTO work_items (id, case_id, spec_version_id, ordinal, title, scope, acceptance_criteria) VALUES (?, ?, ?, ?, ?, ?, ?)",
		itemId,
		caseId,
		id,
		version,
		`item ${version}`,
		"bounded",
		JSON.stringify(["passes"]),
	);
	return id;
}

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("background-agents lifecycle state machine", () => {
	test("enforces case and work-item transition boundaries", () => {
		const database = new BackgroundAgentsDatabase(databasePath());
		const machine = new BackgroundAgentsStateMachine(database);
		const caseId = database.createCase({ title: "Transitions", source: "manual" });
		assert.throws(() => machine.transitionCase(caseId, "handled", "test"), IllegalCaseTransitionError);
		database.transitionCase(caseId, "classified", "test");
		const itemId = machine.createWorkItem({ caseId, ordinal: 1, title: "First unit" });
		machine.transitionWorkItem(itemId, "implementation", "test");
		machine.transitionWorkItem(itemId, "verification", "test");
		machine.transitionWorkItem(itemId, "verified", "test");
		assert.throws(() => machine.transitionWorkItem(itemId, "queued", "test"), IllegalWorkItemTransitionError);
		database.close();
	});

	test("approves only the current exact specification version", () => {
		const database = new BackgroundAgentsDatabase(databasePath());
		const machine = new BackgroundAgentsStateMachine(database);
		const caseId = awaitingApproval(database);
		addSpec(database, caseId, 1);
		addSpec(database, caseId, 2);
		assert.throws(
			() =>
				machine.approveSpecification(caseId, 1, ["repository.read"], "operator", { orderedWorkItems: ["item-1"] }),
			SpecificationVersionMismatchError,
		);
		assert.equal(database.get<{ count: number }>("SELECT count(*) AS count FROM approvals")?.count, 0);
		const result = machine.approveSpecification(caseId, 2, ["repository.read"], "operator", {
			orderedWorkItems: ["item-2"],
		});
		assert.equal(result.specVersion, 2);
		assert.equal(
			database.get<{ state: string }>("SELECT state FROM cases WHERE id = ?", caseId)?.state,
			"implementation",
		);
		assert.deepEqual(
			JSON.parse(
				database.get<{ permissions: string }>("SELECT permissions FROM approvals WHERE id = ?", result.approvalId)!
					.permissions,
			),
			["repository.read"],
		);
		database.close();
	});

	test("pauses and resumes from the durable checkpoint, including usage pauses", () => {
		const database = new BackgroundAgentsDatabase(databasePath());
		const machine = new BackgroundAgentsStateMachine(database);
		const caseId = database.createCase({ title: "Pause", source: "manual" });
		database.transitionCase(caseId, "classified", "test");
		database.transitionCase(caseId, "investigating", "test");
		assert.equal(machine.pauseCase(caseId, "operator"), "paused");
		assert.equal(machine.resumeCase(caseId, "operator"), "investigating");
		database.transitionCase(caseId, "specification", "test");
		database.transitionCase(caseId, "awaiting-approval", "test");
		database.transitionCase(caseId, "implementation", "test");
		assert.equal(machine.pauseCase(caseId, "system", undefined, true), "paused-usage");
		assert.equal(machine.resumeCase(caseId, "operator"), "implementation");
		machine.retryCase(caseId, "system");
		assert.equal(machine.resumeCase(caseId, "operator"), "implementation");
		machine.cancelCase(caseId, "operator");
		assert.equal(database.get<{ state: string }>("SELECT state FROM cases WHERE id = ?", caseId)?.state, "cancelled");
		database.close();
	});
});
