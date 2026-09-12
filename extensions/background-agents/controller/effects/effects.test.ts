import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { BackgroundAgentsDatabase } from "../database.ts";
import { ExternalEffectExecutor } from "./effects.ts";
import { GitHubEffects, type GitHubEffectClient } from "./github.ts";
import { LinearEffects, type LinearEffectClient, type LinearIssueSnapshot } from "./linear.ts";

const directories: string[] = [];

function databasePath(): string {
	const directory = mkdtempSync(join(tmpdir(), "background-effects-"));
	directories.push(directory);
	return join(directory, "controller.sqlite");
}

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("durable external effects", () => {
	test("writes intent before the call, deduplicates success, and reconciles an unknown call", async () => {
		const database = new BackgroundAgentsDatabase(databasePath());
		let calls = 0;
		let reconcileCalls = 0;
		let remoteExists = false;
		const operation = {
			operationKey: "test:effect:1",
			provider: "test",
			action: "create",
			intent: { name: "one" },
			reconcile: async () => {
				reconcileCalls += 1;
				return remoteExists ? { found: true, value: { created: true } } : { found: false };
			},
			perform: async () => {
				calls += 1;
				assert.equal(database.getEffect("test:effect:1")?.reconciliationState, "running");
				remoteExists = true;
				throw new Error("connection lost after remote call");
			},
		};
		const first = new ExternalEffectExecutor(database, { owner: "test-1" });
		await assert.rejects(first.execute(operation), /connection lost/);
		assert.equal(database.getEffect("test:effect:1")?.reconciliationState, "unknown");

		const second = new ExternalEffectExecutor(database, { owner: "test-2" });
		assert.deepEqual(await second.execute(operation), { created: true });
		assert.equal(calls, 1);
		assert.equal(reconcileCalls, 1);
		assert.equal(database.getEffect("test:effect:1")?.reconciliationState, "succeeded");
		assert.deepEqual(await second.execute(operation), { created: true });
		assert.equal(calls, 1);
		database.close();
	});

	test("does not perform a mutation after the durable emergency stop is set", async () => {
		const database = new BackgroundAgentsDatabase(databasePath());
		let performed = false;
		database.setEmergencyStop(true, "operator");
		await assert.rejects(
			new ExternalEffectExecutor(database, { owner: "stopped-test" }).execute({
				operationKey: "test:stopped:1",
				provider: "test",
				action: "mutate",
				intent: {},
				reconcile: async () => ({ found: false }),
				perform: async () => {
					performed = true;
					return {};
				},
			}),
			/emergency stop/,
		);
		assert.equal(performed, false);
		database.close();
	});

	test("only advances an unchanged active Linear issue to preferred In Progress", async () => {
		const database = new BackgroundAgentsDatabase(databasePath());
		let issue: LinearIssueSnapshot = {
			id: "issue-1",
			revision: "rev-1",
			teamKey: "ENG",
			state: { id: "todo", name: "Todo", type: "unstarted" },
		};
		let updates = 0;
		const client: LinearEffectClient = {
			getIssue: async () => issue,
			getStartedStates: async () => [
				{ id: "started", name: "Started", type: "started" },
				{ id: "progress", name: "In Progress", type: "started" },
			],
			updateIssueState: async (_id, stateId) => {
				updates += 1;
				issue = { ...issue, state: { id: stateId, name: "In Progress", type: "started" } };
				return true;
			},
		};
		const effects = new LinearEffects(database, client, { owner: "linear-test" });
		const input = { issue, phase: "investigation" as const };
		const result = await effects.startWork(input);
		assert.equal(result.status, "started");
		assert.equal(result.state.id, "progress");
		assert.equal(updates, 1);
		assert.equal((await effects.startWork(input)).status, "started");
		assert.equal(updates, 1);

		issue = { ...issue, revision: "rev-2", state: { id: "done", name: "Done", type: "completed" } };
		const preserved = await new LinearEffects(database, client, { owner: "linear-test-2" }).startWork({
			issue: { ...input.issue, revision: "rev-2" },
			phase: "specification",
		});
		assert.equal(preserved.status, "preserved");
		assert.equal(updates, 1);
		database.close();
	});

	test("does not create a draft over an existing ready pull request", async () => {
		const database = new BackgroundAgentsDatabase(databasePath());
		const client: GitHubEffectClient = {
			pushBranch: async () => {},
			getBranchHead: async () => null,
			findPullRequest: async () => ({
				number: 9,
				url: "https://github.test/pr/9",
				branch: "feature",
				base: "main",
				isDraft: false,
			}),
			createDraftPullRequest: async () => {
				throw new Error("must not create");
			},
			updatePullRequest: async () => {},
			getPullRequest: async () => null,
			linkStack: async () => {},
			isStackLinked: async () => false,
			markReady: async () => {},
		};
		await assert.rejects(
			new GitHubEffects(database, client, { owner: "github-conflict" }).createDraftPullRequest({
				worktree: "/tmp/worktree",
				branch: "feature",
				base: "main",
				title: "title",
				body: "body",
			}),
			/existing pull request is not a draft/,
		);
		database.close();
	});

	test("reconciles a GitHub push and ready effect without repeating mutations", async () => {
		const database = new BackgroundAgentsDatabase(databasePath());
		const caseId = database.createCase({ title: "Ready", source: "manual" });
		const manifestId = database.createEvidenceManifest({
			caseId,
			manifest: {
				version: 1,
				baseSha: "base",
				candidateSha: "abc",
				commands: [],
				createdAt: new Date().toISOString(),
			},
		});
		const verificationRunId = database.createVerificationRun({
			manifestId,
			report: {
				verdict: "pass",
				confidence: { score: 95, rationale: "verified", uncertainties: [] },
				ciChecks: {},
				rationale: "verified",
				uncertainties: [],
				replay: { commands: [] },
			},
		});
		let branchHead: string | null = null;
		let pullRequest = {
			number: 7,
			url: "https://github.test/pull/7",
			branch: "background/case/1",
			base: "main",
			isDraft: true,
			headSha: "different-head",
			title: "Title",
			body: "Body",
		};
		let pushes = 0;
		let readyCalls = 0;
		const client: GitHubEffectClient = {
			pushBranch: async () => {
				pushes += 1;
				branchHead = "abc";
				throw new Error("push response lost");
			},
			getBranchHead: async () => branchHead,
			findPullRequest: async () => pullRequest,
			createDraftPullRequest: async () => pullRequest,
			updatePullRequest: async () => undefined,
			getPullRequest: async () => pullRequest,
			linkStack: async () => undefined,
			isStackLinked: async () => false,
			markReady: async (_reference, boundary) => {
				assert.equal(boundary.passed, true);
				assert.equal(boundary.verifiedCommit, "abc");
				assert.equal(boundary.requiredCiPassed, true);
				readyCalls += 1;
				pullRequest = { ...pullRequest, isDraft: false };
				if (readyCalls === 1) throw new Error("ready response lost");
			},
		};
		const effects = new GitHubEffects(database, client, { owner: "github-test" });
		const blocked = await effects.readyForReview({
			reference: 7,
			verifiedCommit: "abc",
			verificationPassed: true,
			manifestId,
			verificationRunId,
			requiredChecks: [],
		});
		assert.equal(blocked.status, "blocked");
		assert.equal(readyCalls, 0);
		pullRequest = { ...pullRequest, headSha: "abc" };
		await assert.rejects(
			effects.pushBranch({ worktree: "/worktree", branch: pullRequest.branch, expectedHeadSha: "abc" }),
			/push response lost/,
		);
		const pushed = await new GitHubEffects(database, client, { owner: "github-test-2" }).pushBranch({
			worktree: "/worktree",
			branch: pullRequest.branch,
			expectedHeadSha: "abc",
		});
		assert.equal(pushed.headSha, "abc");
		assert.equal(pushes, 1);

		await assert.rejects(
			effects.readyForReview({
				reference: 7,
				verifiedCommit: "abc",
				verificationPassed: true,
				manifestId,
				verificationRunId,
				requiredChecks: [],
			}),
			/ready response lost/,
		);
		const ready = await new GitHubEffects(database, client, { owner: "github-test-2" }).readyForReview({
			reference: 7,
			verifiedCommit: "abc",
			verificationPassed: true,
			manifestId,
			verificationRunId,
			requiredChecks: [],
		});
		assert.equal(ready.status, "already-ready");
		assert.equal(readyCalls, 1);
		database.close();
	});

	test("blocks readiness without current verification, required CI, or emergency-stop clearance", async () => {
		const database = new BackgroundAgentsDatabase(databasePath());
		const caseId = database.createCase({ title: "Guards", source: "manual" });
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
		const verificationRunId = database.createVerificationRun({
			manifestId,
			report: {
				verdict: "pass",
				confidence: { score: 95, rationale: "verified", uncertainties: [] },
				ciChecks: {},
				rationale: "verified",
				uncertainties: [],
				replay: { commands: [] },
			},
		});
		let readyCalls = 0;
		const client: GitHubEffectClient = {
			pushBranch: async () => undefined,
			getBranchHead: async () => "candidate",
			findPullRequest: async () => null,
			createDraftPullRequest: async () => ({
				number: 1,
				url: "https://github.test/1",
				branch: "b",
				base: "main",
				isDraft: true,
				headSha: "candidate",
			}),
			updatePullRequest: async () => undefined,
			getPullRequest: async () => ({
				number: 1,
				url: "https://github.test/1",
				branch: "b",
				base: "main",
				isDraft: true,
				headSha: "candidate",
			}),
			linkStack: async () => undefined,
			isStackLinked: async () => false,
			markReady: async (_reference, boundary) => {
				assert.equal(boundary.passed, true);
				assert.equal(boundary.verifiedCommit, "candidate");
				assert.equal(boundary.requiredCiPassed, true);
				readyCalls += 1;
			},
		};
		const effects = new GitHubEffects(database, client, { owner: "guard-test" });
		await assert.rejects(
			effects.readyForReview({
				reference: 1,
				verifiedCommit: "candidate",
				verificationPassed: true,
				requiredChecks: [],
			}),
			/stored verification/,
		);
		await assert.rejects(
			effects.readyForReview({
				reference: 1,
				verifiedCommit: "candidate",
				verificationPassed: true,
				manifestId,
				verificationRunId,
				requiredChecks: ["build"],
			}),
			/required CI check/,
		);
		database.setEmergencyStop(true, "operator");
		await assert.rejects(
			effects.readyForReview({
				reference: 1,
				verifiedCommit: "candidate",
				verificationPassed: true,
				manifestId,
				verificationRunId,
				requiredChecks: [],
			}),
			/emergency stop/,
		);
		assert.equal(readyCalls, 0);
		database.close();
	});
});
