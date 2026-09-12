import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { normalizeBackgroundAgentsConfig } from "../config.ts";
import { BackgroundAgentsDatabase } from "./database.ts";
import { GitRepository } from "./git/repository.ts";
import { GitWorktreeManager, backgroundBranch, type WorktreeRecord } from "./git/worktree.ts";
import {
	combinedRequiredChecks,
	ProductionAttemptRunner,
	VERIFICATION_RESULT_FILE,
	VERIFICATION_RESULT_VERSION,
} from "./attempt-runner.ts";
import type { GitHubEffectClient } from "./effects/github.ts";
import { BackgroundAgentsStateMachine } from "./state-machine.ts";
import { JobScheduler } from "./jobs.ts";
import { SpecificationWorkflow } from "./workflows/specification.ts";
import { createEvidenceManifest } from "./verification/evidence.ts";

const SHA = "0123456789012345678901234567890123456789";

test("verifier requirements combine global and repository checks without duplicates", () => {
	assert.deepEqual(combinedRequiredChecks(["lint", "test"], ["test", "integration"]), ["lint", "test", "integration"]);
});

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
			decomposition: [
				{
					order: 1,
					title: "Implement plan",
					scope: "bounded implementation",
					acceptanceCriteria: ["the plan is implemented"],
				},
			],
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
	const calls: Array<{ role: string; tools: string[]; prompt: string; rolePromptPath: string }> = [];
	let workerBaseSha = SHA;
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
				calls.push({
					role: options.role,
					tools: options.runtime.tools,
					prompt: options.prompt ?? "",
					rolePromptPath: options.rolePromptPath,
				});
				const resultPath = String(options.context.context.resultPath);
				writeFileSync(
					resultPath,
					JSON.stringify({
						version: 1,
						attemptId: options.attemptId,
						jobId: String(options.context.context.jobId),
						role: options.role,
						state: "succeeded",
						output:
							options.role === "worker"
								? {
										...outputFor(options.role),
										evidenceManifest: {
											...(outputFor(options.role).evidenceManifest as object),
											baseSha: workerBaseSha,
										},
									}
								: outputFor(options.role),
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
				const specification = new SpecificationWorkflow(database);
				specification.recordPlannerResult(caseId, {
					specification: {},
					decisions: [],
					unresolvedQuestions: [],
					permissions: [],
					plannerSummary: "test",
					decomposition: [
						{
							order: 1,
							title: "Implement test",
							scope: "bounded test implementation",
							acceptanceCriteria: ["the test behavior passes"],
						},
					],
				});
				workItemId = specification.context(caseId).latest?.orderedWorkItems[0];
				if (!workItemId) throw new Error("planner did not create a work item");
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
		for (const call of calls) {
			assert.match(call.rolePromptPath, new RegExp(`/extensions/background-agents/roles/${call.role}\\.md$`));
			assert.match(call.prompt, /context-manifest\.json/);
			assert.match(call.prompt, /result\.json/);
		}
		const checkpoint = database.get<{ digest: string; path: string; metadata: string }>(
			"SELECT digest, path, metadata FROM recovery_checkpoints ORDER BY created_at DESC LIMIT 1",
		);
		assert.equal(checkpoint?.digest?.length, 64);
		assert.ok(checkpoint?.path?.endsWith("context-manifest.json"));
		assert.match(checkpoint?.metadata ?? "", /artifactId/);
		workerBaseSha = "different-controller-base";
		const worker = jobs.find((item) => item.role === "worker")!;
		const retryJobId = database.createJob({ caseId: worker.caseId, role: "worker", workItemId: worker.workItemId });
		const retryResult = await runner.run(database.claimJob(retryJobId, "test")!, database);
		assert.equal(retryResult.state, "failed");
		assert.match(retryResult.failure ?? "", /baseSha does not match controller assignment/);
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

test("delivers an approved two-item stack through durable GitHub effects", async () => {
	const root = mkdtempSync(join(tmpdir(), "background-stack-runner-"));
	const database = new BackgroundAgentsDatabase(":memory:");
	const baseSha = "0".repeat(40);
	const candidateShas = ["1".repeat(40), "2".repeat(40)];
	const branches = [backgroundBranch("case-stack", 1), backgroundBranch("case-stack", 2)];
	const heads = new Map<string, string>();
	const pullRequests = new Map<
		number,
		{
			number: number;
			url: string;
			branch: string;
			base: string;
			isDraft: boolean;
			headSha?: string;
			title?: string;
			body?: string;
		}
	>();
	const ready: number[] = [];
	const linked: string[][] = [];
	let nextNumber = 1;
	const client: GitHubEffectClient = {
		pushBranch: async (_worktree, branch, remote) => {
			assert.equal(remote, "upstream");
			heads.set(branch, candidateShas[branches.indexOf(branch)] ?? "");
		},
		getBranchHead: async (branch) => heads.get(branch) ?? null,
		findPullRequest: async (branch, base) =>
			[...pullRequests.values()].find((pullRequest) => pullRequest.branch === branch && pullRequest.base === base) ??
			null,
		createDraftPullRequest: async (input) => {
			const pullRequest = {
				number: nextNumber++,
				url: `https://github.test/pr/${nextNumber}`,
				branch: input.branch,
				base: input.base,
				isDraft: true,
				headSha: heads.get(input.branch),
				title: input.title,
				body: input.body,
			};
			pullRequests.set(pullRequest.number, pullRequest);
			return pullRequest;
		},
		updatePullRequest: async (reference, metadata) => {
			const pullRequest = pullRequests.get(Number(reference));
			assert.ok(pullRequest);
			Object.assign(pullRequest, metadata);
		},
		getPullRequest: async (reference) => pullRequests.get(Number(reference)) ?? null,
		linkStack: async (items) => {
			linked.push([...items]);
		},
		isStackLinked: async () => linked.length > 0,
		markReady: async (reference, boundary) => {
			assert.equal(boundary.passed, true);
			assert.equal(boundary.requiredCiPassed, true);
			const pullRequest = pullRequests.get(Number(reference));
			assert.ok(pullRequest);
			pullRequest.isDraft = false;
			ready.push(Number(reference));
		},
	};
	const config = normalizeBackgroundAgentsConfig({
		databasePath: join(root, "controller.sqlite"),
		repositories: [
			{
				id: "repo",
				root,
				gitDir: join(root, ".git"),
				remote: "upstream",
				defaultBaseBranch: "trunk",
				requiredChecks: ["repository-ci"],
			},
		],
		ci: { requiredChecks: ["global-ci"] },
		profiles: [{ id: "profile", provider: "anthropic", agentDir: root, allowedModels: ["model"] }],
	});
	const gitRunner = async (_command: string, args: string[]) => {
		const cwd = args[1] ?? "";
		if (args[2] === "rev-parse") {
			if (cwd.endsWith("/1")) return { code: 0, stdout: `${candidateShas[0]}\n`, stderr: "" };
			if (cwd.endsWith("/2")) return { code: 0, stdout: `${candidateShas[1]}\n`, stderr: "" };
			if (args[3]?.includes("background/case-stack/1"))
				return { code: 0, stdout: `${candidateShas[0]}\n`, stderr: "" };
			return { code: 0, stdout: `${baseSha}\n`, stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	};
	const runner = new ProductionAttemptRunner({
		config,
		attemptRoot: join(root, "attempts"),
		worktreeRoot: join(root, "worktrees"),
		repositoryFactory: (path) => new GitRepository(path, gitRunner),
		worktreeFactory: (repository, path) => new TestWorktrees(repository, path),
		githubClient: client,
		launch: async (options) => {
			const resultPath = String(options.context.context.resultPath);
			const workItem = options.context.context.workItem as { ordinal?: number } | undefined;
			const ordinal = Number(workItem?.ordinal ?? (options.worktreeDirectory.endsWith("/1") ? 1 : 2));
			const candidateSha = candidateShas[ordinal - 1] ?? baseSha;
			if (options.role === "worker") {
				writeFileSync(
					resultPath,
					JSON.stringify({
						version: 1,
						attemptId: options.attemptId,
						jobId: String(options.context.context.jobId),
						role: "worker",
						state: "succeeded",
						output: {
							commitSha: candidateSha,
							evidenceManifest: {
								baseSha: ordinal === 1 ? baseSha : candidateShas[ordinal - 2],
								candidateSha,
								commands: [
									{ executable: "true", argv: [], timeoutMs: 1000, phase: "candidate", purpose: "acceptance" },
								],
							},
						},
					}),
				);
			} else {
				const checks = { "global-ci": "pass", "repository-ci": "pass" } as const;
				writeFileSync(
					resultPath,
					JSON.stringify({
						version: 1,
						attemptId: options.attemptId,
						jobId: String(options.context.context.jobId),
						role: "verifier",
						state: "succeeded",
						output: { verdict: "pass" },
					}),
				);
				writeFileSync(
					join(options.attemptDirectory, VERIFICATION_RESULT_FILE),
					JSON.stringify({
						version: VERIFICATION_RESULT_VERSION,
						report: {
							verdict: "pass",
							confidence: { score: 95, rationale: "exact", uncertainties: [] },
							ciChecks: checks,
							rationale: "exact",
							uncertainties: [],
							replay: {
								passed: true,
								clean: true,
								ancestry: true,
								commands: [],
								rationale: "exact",
								uncertainties: [],
							},
							ci: { checks, results: [], allRequiredPassed: true, missing: [], uncertainties: [] },
							candidateSha,
						},
					}),
				);
			}
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
	try {
		const caseId = database.createCase({ id: "case-stack", title: "stack", source: "manual", repository: "repo" });
		const machine = new BackgroundAgentsStateMachine(database);
		database.transitionCase(caseId, "classified", "test");
		database.transitionCase(caseId, "specification", "test");
		const specification = new SpecificationWorkflow(database);
		specification.recordPlannerResult(caseId, {
			specification: {},
			decisions: [],
			unresolvedQuestions: [],
			permissions: [],
			plannerSummary: "stack",
			decomposition: [
				{ order: 1, title: "Bottom change", scope: "bottom bounded change", acceptanceCriteria: ["bottom passes"] },
				{ order: 2, title: "Top change", scope: "top bounded change", acceptanceCriteria: ["top passes"] },
			],
		});
		const first = specification.context(caseId).latest?.orderedWorkItems[0];
		const second = specification.context(caseId).latest?.orderedWorkItems[1];
		if (!first || !second) throw new Error("planner did not create the work-item chain");
		specification.approve(caseId, 1, [], "operator", [first, second]);
		const execute = async (jobId: string) => {
			const claim = database.claimJob(jobId, "test");
			assert.ok(claim);
			const result = await runner.run(claim!, database);
			assert.equal(result.state, "succeeded", result.failure ?? "");
			assert.equal(
				new JobScheduler(database).finishAttempt({ attemptId: claim!.attemptId, state: "succeeded" }, "test"),
				true,
			);
		};
		const firstWorker = database.get<{ id: string }>(
			"SELECT id FROM jobs WHERE work_item_id = ? AND role = 'worker'",
			first,
		);
		assert.ok(firstWorker);
		await execute(firstWorker!.id);
		const firstVerifier = database.get<{ id: string }>(
			"SELECT id FROM jobs WHERE work_item_id = ? AND role = 'verifier'",
			first,
		);
		assert.ok(firstVerifier);
		await execute(firstVerifier!.id);
		const secondWorker = database.get<{ id: string }>(
			"SELECT id FROM jobs WHERE work_item_id = ? AND role = 'worker'",
			second,
		);
		assert.ok(secondWorker);
		await execute(secondWorker!.id);
		const secondVerifier = database.get<{ id: string }>(
			"SELECT id FROM jobs WHERE work_item_id = ? AND role = 'verifier'",
			second,
		);
		assert.ok(secondVerifier);
		await execute(secondVerifier!.id);
		assert.deepEqual(ready, [1, 2]);
		assert.deepEqual(linked, [branches]);
		assert.equal(
			database.get<{ pull_request: number }>("SELECT pull_request FROM work_items WHERE id = ?", first)
				?.pull_request,
			1,
		);
		assert.equal(
			database.get<{ pull_request: number }>("SELECT pull_request FROM work_items WHERE id = ?", second)
				?.pull_request,
			2,
		);
		assert.equal(
			[...pullRequests.values()].every((pullRequest) => !pullRequest.isDraft),
			true,
		);
		assert.equal(database.all("SELECT id FROM jobs WHERE role = 'worker'").length, 2);
		assert.equal(
			database
				.all("SELECT path FROM artifacts WHERE kind = 'evidence-manifest'")
				.every((row) => !String(row.path).includes("worktrees")),
			true,
		);
	} finally {
		database.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("question investigators store a private brief and never start specification work", async () => {
	const root = mkdtempSync(join(tmpdir(), "background-question-runner-"));
	const database = new BackgroundAgentsDatabase(":memory:");
	try {
		const config = normalizeBackgroundAgentsConfig({
			profiles: [{ id: "profile", provider: "anthropic", agentDir: root }],
		});
		const caseId = database.createCase({ id: "question-runner", title: "question", source: "manual" });
		database.transitionCase(caseId, "classified", "test");
		database.transitionCase(caseId, "question-analysis", "test");
		database.recordSourceEvent(
			{
				source: "manual",
				sourceKey: "question-source",
				receivedAt: new Date().toISOString(),
				title: "question",
				body: "Why did this happen?",
			},
			{ caseId },
		);
		const jobId = database.createJob({ caseId, role: "investigator" });
		const claim = database.claimJob(jobId, "test")!;
		let capturedContext: Record<string, unknown> | undefined;
		let capturedPrompt = "";
		let capturedRuntimeMs = 0;
		const runner = new ProductionAttemptRunner({
			config,
			attemptRoot: join(root, "attempts"),
			launch: async (options) => {
				capturedContext = options.context.context;
				capturedPrompt = options.prompt ?? "";
				capturedRuntimeMs = options.limits.maxRuntimeMs;
				writeFileSync(
					String(options.context.context.resultPath),
					JSON.stringify({
						version: 1,
						attemptId: options.attemptId,
						jobId,
						role: "investigator",
						state: "succeeded",
						output: { findings: "transient", sources: ["event"], confidence: 80, uncertainties: [] },
					}),
				);
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
		assert.equal((await runner.run(claim, database)).state, "succeeded");
		assert.equal(capturedContext?.mode, "question-analysis");
		assert.equal(capturedContext?.question, "Why did this happen?");
		assert.equal((capturedContext?.limits as { maxAttempts?: number }).maxAttempts, 1);
		assert.equal(capturedRuntimeMs, 60_000);
		assert.match(capturedPrompt, /private brief/);
		assert.equal(database.get<{ state: string }>("SELECT state FROM cases WHERE id = ?", caseId)?.state, "handled");
		assert.equal(
			database.get<{ count: number }>("SELECT count(*) AS count FROM question_briefs WHERE case_id = ?", caseId)
				?.count,
			1,
		);
		assert.equal(
			database.get<{ count: number }>("SELECT count(*) AS count FROM spec_versions WHERE case_id = ?", caseId)
				?.count,
			0,
		);
	} finally {
		database.close();
		rmSync(root, { recursive: true, force: true });
	}
});
