import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { normalizeBackgroundAgentsConfig } from "../config.ts";
import { BackgroundAgentsDatabase } from "./database.ts";
import { GitRepository } from "./git/repository.ts";
import { GitWorktreeManager, backgroundBranch, type WorktreeRecord } from "./git/worktree.ts";
import { ProductionAttemptRunner } from "./attempt-runner.ts";
import { BackgroundAgentsStateMachine } from "./state-machine.ts";
import { SpecificationWorkflow } from "./workflows/specification.ts";
import { createEvidenceManifest } from "./verification/evidence.ts";

const SHA = "0123456789012345678901234567890123456789";

class TestWorktrees extends GitWorktreeManager {
	constructor(repository: GitRepository, root: string) {
		super(repository, root);
	}
	async ensure(input: { caseId: string; ordinal: number; owner: string; baseRef: string }): Promise<WorktreeRecord> {
		const path = join(this.worktreeRoot, input.caseId, String(input.ordinal));
		mkdirSync(path, { recursive: true });
		return { path, branch: backgroundBranch(input.caseId, input.ordinal), head: input.baseRef, dirty: false };
	}
}

function outputFor(role: string): Record<string, unknown> {
	if (role === "classifier")
		return { inputKind: "bug-report", actionability: 90, noise: 0, confidence: 90, rationale: "evidence" };
	if (role === "investigator")
		return { autonomy: "spec-required", findings: "finding", confidence: 80, uncertainties: [] };
	if (role === "spec-planner")
		return {
			specification: { goal: "goal" },
			decisions: [],
			unresolvedQuestions: [],
			permissions: [],
			plannerSummary: "plan",
		};
	if (role === "worker")
		return {
			commitSha: SHA,
			evidenceManifest: {
				baseSha: SHA,
				candidateSha: SHA,
				commands: [{ executable: "true", argv: [], timeoutMs: 1000, phase: "candidate", purpose: "acceptance" }],
			},
		};
	return { verdict: "pass" };
}

test("production runner dispatches every role through its profile boundary", async () => {
	const root = mkdtempSync(join(tmpdir(), "background-attempt-runner-"));
	const database = new BackgroundAgentsDatabase(":memory:");
	const calls: Array<{ role: string; tools: string[] }> = [];
	try {
		const config = normalizeBackgroundAgentsConfig({
			databasePath: join(root, "controller.sqlite"),
			repositories: [{ id: "repo", root, gitDir: join(root, ".git") }],
			profiles: [{ id: "profile", provider: "anthropic", agentDir: root, allowedModels: ["model"] }],
		});
		const gitRunner = async (_command: string, args: string[]) => ({
			code: 0,
			stdout: args.includes("rev-parse") ? `${SHA}\n` : "",
			stderr: "",
		});
		const runner = new ProductionAttemptRunner({
			config,
			attemptRoot: join(root, "attempts"),
			worktreeRoot: join(root, "worktrees"),
			repositoryFactory: (path) => new GitRepository(path, gitRunner),
			worktreeFactory: (repository, path) => new TestWorktrees(repository, path),
			launch: async (options) => {
				calls.push({ role: options.role, tools: options.runtime.tools });
				const resultPath = String(options.context.context.resultPath);
				writeFileSync(
					resultPath,
					JSON.stringify({
						version: 1,
						attemptId: options.attemptId,
						jobId: String(options.context.context.jobId),
						role: options.role,
						state: "succeeded",
						output: outputFor(options.role),
					}),
				);
				return {
					attemptId: options.attemptId,
					unit: `unit-${options.attemptId}`,
					tabId: "tab",
					paneId: "pane",
					contextPath: "context",
					command: [],
				};
			},
			waitForUnit: async () => ({ state: "succeeded" }),
		});
		const machine = new BackgroundAgentsStateMachine(database);
		const jobs: Array<{
			role: "classifier" | "investigator" | "spec-planner" | "worker" | "verifier";
			caseId: string;
			workItemId?: string;
		}> = [];
		for (const role of ["classifier", "investigator", "spec-planner", "worker", "verifier"] as const) {
			const state =
				role === "classifier"
					? "intake"
					: role === "investigator"
						? "investigating"
						: role === "spec-planner"
							? "specification"
							: role === "worker"
								? "implementation"
								: "verification";
			const caseId = database.createCase({ id: `case-${role}`, title: role, source: "manual", repository: "repo" });
			if (role === "worker" || role === "verifier") {
				database.transitionCase(caseId, "classified", "test");
				database.transitionCase(caseId, "specification", "test");
			} else if (state !== "intake") {
				database.transitionCase(caseId, "classified", "test");
				database.transitionCase(caseId, state, "test");
			}
			if (role === "classifier" || role === "investigator")
				database.recordSourceEvent(
					{
						source: "manual",
						sourceKey: `source-${role}`,
						receivedAt: new Date().toISOString(),
						title: role,
						body: "body",
					},
					{ caseId },
				);
			let workItemId: string | undefined;
			if (role === "worker" || role === "verifier") {
				workItemId = machine.createWorkItem({ caseId, ordinal: 1, title: role });
				const specification = new SpecificationWorkflow(database);
				specification.recordPlannerResult(caseId, {
					specification: {},
					decisions: [],
					unresolvedQuestions: [],
					permissions: [],
					plannerSummary: "test",
				});
				specification.approve(caseId, 1, [], "operator", [workItemId]);
				if (role === "verifier") database.transitionCase(caseId, "verification", "test");
				if (role === "verifier") {
					machine.transitionWorkItem(workItemId, "implementation", "test");
					machine.transitionWorkItem(workItemId, "verification", "test");
					database.createEvidenceManifest({
						caseId,
						manifest: createEvidenceManifest({
							baseSha: SHA,
							candidateSha: SHA,
							commands: [
								{ executable: "true", argv: [], timeoutMs: 1000, phase: "candidate", purpose: "acceptance" },
							],
						}),
					});
				}
			}
			jobs.push({ role, caseId, ...(workItemId ? { workItemId } : {}) });
		}
		for (const item of jobs) {
			const jobId = database.createJob({
				caseId: item.caseId,
				role: item.role,
				...(item.workItemId ? { workItemId: item.workItemId } : {}),
			});
			const claim = database.claimJob(jobId, "test")!;
			const result = await runner.run(claim, database);
			assert.equal(result.state, "succeeded", `${item.role}: ${result.failure ?? ""}`);
		}
		assert.deepEqual(
			calls.map((call) => call.role),
			["classifier", "investigator", "spec-planner", "worker", "verifier"],
		);
		assert.deepEqual(
			calls.map((call) => call.tools),
			[
				[],
				["read", "grep", "find", "ls"],
				["read", "grep", "find", "ls"],
				["read", "write", "edit", "grep", "find", "ls", "bash"],
				["read", "grep", "find", "ls", "bash"],
			],
		);
	} finally {
		database.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("invalid or missing result artifacts require human review", async () => {
	const root = mkdtempSync(join(tmpdir(), "background-attempt-result-"));
	const database = new BackgroundAgentsDatabase(":memory:");
	try {
		const config = normalizeBackgroundAgentsConfig({
			profiles: [{ id: "profile", provider: "anthropic", agentDir: root }],
		});
		const caseId = database.createCase({ id: "invalid-result", title: "invalid", source: "manual" });
		database.transitionCase(caseId, "classified", "test");
		database.transitionCase(caseId, "investigating", "test");
		database.recordSourceEvent(
			{
				source: "manual",
				sourceKey: "invalid-source",
				receivedAt: new Date().toISOString(),
				title: "invalid",
				body: "body",
			},
			{ caseId },
		);
		const jobId = database.createJob({ caseId, role: "investigator" });
		const claim = database.claimJob(jobId, "test")!;
		const runner = new ProductionAttemptRunner({
			config,
			attemptRoot: join(root, "attempts"),
			launch: async (options) => {
				writeFileSync(String(options.context.context.resultPath), "not-json");
				return {
					attemptId: options.attemptId,
					unit: "unit",
					tabId: "tab",
					paneId: "pane",
					contextPath: "context",
					command: [],
				};
			},
			waitForUnit: async () => ({ state: "succeeded" }),
		});
		const result = await runner.run(claim, database);
		assert.equal(result.state, "needs-human");
		assert.match(result.failure ?? "", /result artifact/);
		assert.equal(database.get("SELECT id FROM investigation_reports WHERE case_id = ?", caseId), undefined);
	} finally {
		database.close();
		rmSync(root, { recursive: true, force: true });
	}
});
