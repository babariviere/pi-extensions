import {
	ExternalEffectExecutor,
	type EffectExecutorOptions,
	type EffectReconciliation,
	type EffectStore,
} from "./effects.ts";
import {
	GitHubController,
	type DraftPullRequestInput,
	type GitHubPullRequest,
	type VerificationBoundary,
} from "../git/github.ts";

export interface GitHubEffectPullRequest extends GitHubPullRequest {
	headSha?: string;
	title?: string;
	body?: string;
}

export class GitHubDraftConflictError extends Error {
	constructor(readonly pullRequest: GitHubEffectPullRequest) {
		super(`an existing pull request is not a draft: #${pullRequest.number}`);
		this.name = "GitHubDraftConflictError";
	}
}

export interface GitHubEffectClient {
	pushBranch(worktree: string, branch: string, remote: string): Promise<{ headSha?: string } | void>;
	getBranchHead(branch: string, remote: string): Promise<string | null>;
	findPullRequest(branch: string, base: string): Promise<GitHubEffectPullRequest | null>;
	createDraftPullRequest(input: DraftPullRequestInput): Promise<GitHubEffectPullRequest>;
	updatePullRequest(reference: number | string, metadata: { title: string; body: string }): Promise<void>;
	getPullRequest(reference: number | string): Promise<GitHubEffectPullRequest | null>;
	linkStack(branches: readonly string[]): Promise<void>;
	isStackLinked(branches: readonly string[]): Promise<boolean>;
	markReady(reference: number | string, boundary: VerificationBoundary): Promise<void>;
	/** Provider-side lease for the PR branch. The lease is retained after ready. */
	acquireBranchLock?(branch: string, expectedHeadSha: string): Promise<{ release: () => Promise<void> }>;
}

/** Adapter for the argv-only GitHub controller used by the repository layer. */
export class GitHubControllerEffectClient implements GitHubEffectClient {
	constructor(readonly github: GitHubController) {}

	async pushBranch(worktree: string, branch: string, remote: string): Promise<void> {
		await this.github.pushBranch(worktree, branch, remote);
	}

	async getBranchHead(branch: string, remote: string): Promise<string | null> {
		const result = await this.github.repository.command(["ls-remote", remote, `refs/heads/${branch}`]);
		if (result.code !== 0) throw new Error(result.stderr.trim() || "git ls-remote failed");
		return result.stdout.trim().split(/\s+/)[0] || null;
	}

	findPullRequest(branch: string, base: string): Promise<GitHubEffectPullRequest | null> {
		return this.github.findPullRequest(branch, base);
	}

	createDraftPullRequest(input: DraftPullRequestInput): Promise<GitHubEffectPullRequest> {
		return this.github.createDraftPullRequest(input);
	}

	updatePullRequest(reference: number | string, metadata: { title: string; body: string }): Promise<void> {
		return this.github.updatePullRequest(reference, metadata);
	}

	getPullRequest(reference: number | string): Promise<GitHubEffectPullRequest | null> {
		return this.github.getPullRequest(reference);
	}

	linkStack(branches: readonly string[]): Promise<void> {
		return this.github.linkStack(branches);
	}

	async isStackLinked(branches: readonly string[]): Promise<boolean> {
		for (let index = 1; index < branches.length; index += 1) {
			const pullRequest = await this.github.findPullRequest(branches[index], branches[index - 1]);
			if (!pullRequest) return false;
		}
		return true;
	}

	async markReady(reference: number | string, boundary: VerificationBoundary): Promise<void> {
		if (!boundary.passed) throw new Error("a pull request can become ready only after passed verification");
		const verifiedCommit = boundary.verifiedCommit?.trim();
		if (!verifiedCommit) throw new Error("ready-for-review requires a verified commit");
		if (boundary.requiredCiPassed !== true) throw new Error("required CI has not passed");
		const pullRequest = await this.github.getPullRequest(reference);
		if (!pullRequest) throw new Error("GitHub pull request was not found");
		if (pullRequest.headSha?.toLowerCase() !== verifiedCommit.toLowerCase())
			throw new Error("GitHub pull request head does not match verified commit");
		if (boundary.expectedBaseSha && pullRequest.baseSha?.toLowerCase() !== boundary.expectedBaseSha.toLowerCase())
			throw new Error("GitHub pull request base SHA does not match verified base");
		const result = await this.github.repository.runner("gh", ["pr", "ready", String(reference)], {
			cwd: this.github.repository.root,
		});
		if (result.code !== 0) throw new Error(result.stderr.trim() || "gh pr ready failed");
		const ready = await this.github.getPullRequest(reference);
		if (
			!ready ||
			ready.headSha?.toLowerCase() !== verifiedCommit.toLowerCase() ||
			(boundary.expectedBaseSha !== undefined &&
				ready.baseSha?.toLowerCase() !== boundary.expectedBaseSha.toLowerCase())
		)
			throw new Error("GitHub pull request SHA changed after marking ready");
	}

	acquireBranchLock(branch: string, expectedHeadSha: string): Promise<{ release: () => Promise<void> }> {
		return this.github.acquireBranchLock(branch, expectedHeadSha);
	}
}

export interface PushBranchInput {
	worktree: string;
	branch: string;
	remote?: string;
	expectedHeadSha?: string;
}

export interface PushBranchResult {
	branch: string;
	remote: string;
	headSha?: string;
}

export interface DraftPullRequestResult {
	pullRequest: GitHubEffectPullRequest;
}

export interface ReadyForReviewInput {
	reference: number | string;
	verifiedCommit: string;
	expectedBaseSha?: string;
	verificationPassed: boolean;
	requiredCiPassed?: boolean;
	manifestId?: string;
	verificationRunId?: string;
	requiredChecks: readonly string[];
}

export type ReadyForReviewStatus = "ready" | "already-ready" | "blocked";

export interface ReadyForReviewResult {
	status: ReadyForReviewStatus;
	pullRequest: GitHubEffectPullRequest;
}

export function githubPushOperationKey(remote: string, branch: string, expectedHeadSha?: string): string {
	return `github:push:${remote}:${branch}:${expectedHeadSha ?? "branch"}`;
}

export function githubDraftOperationKey(branch: string, base: string, baseSha?: string): string {
	return `github:pr:create:${branch}:${base}${baseSha ? `:${baseSha}` : ""}`;
}

function validateDraftPullRequest(input: DraftPullRequestInput, pullRequest: GitHubEffectPullRequest): void {
	if (pullRequest.base !== input.base) throw new Error("GitHub pull request base does not match requested base");
	if (input.baseSha) {
		if (!pullRequest.baseSha) throw new Error("GitHub pull request response is missing requested base SHA");
		if (pullRequest.baseSha.toLowerCase() !== input.baseSha.toLowerCase())
			throw new Error("GitHub pull request base SHA does not match requested base");
	}
}

export function githubEditOperationKey(reference: number | string, title: string, body: string): string {
	return `github:pr:edit:${reference}:${title}:${body}`;
}

export function githubStackOperationKey(branches: readonly string[]): string {
	return `github:stack:link:${branches.join(",")}`;
}

export function githubReadyOperationKey(
	reference: number | string,
	verifiedCommit: string,
	verificationRunId = "verification-required",
	requiredChecks: readonly string[] = [],
	expectedBaseSha?: string,
): string {
	return `github:pr:ready:${reference}:${verifiedCommit}:${expectedBaseSha ?? "base-required"}:${verificationRunId}:${requiredChecks.join(",")}`;
}

/** Durable GitHub delivery effects. There is intentionally no merge operation. */
export class GitHubEffects {
	private readonly executor: ExternalEffectExecutor;
	private readonly requireBranchLock: boolean;

	constructor(
		readonly store: EffectStore,
		readonly client: GitHubEffectClient,
		options: EffectExecutorOptions,
	) {
		this.executor = new ExternalEffectExecutor(store, options);
		this.requireBranchLock = options.requireBranchLock === true;
	}

	async pushBranch(input: PushBranchInput): Promise<PushBranchResult> {
		const remote = input.remote ?? "origin";
		const operationKey = githubPushOperationKey(remote, input.branch, input.expectedHeadSha);
		const result = await this.executor.execute<PushBranchResult>({
			operationKey,
			provider: "github",
			action: "push-branch",
			intent: { worktree: input.worktree, branch: input.branch, remote, expectedHeadSha: input.expectedHeadSha },
			reconcile: async () => {
				const headSha = await this.client.getBranchHead(input.branch, remote);
				if (!headSha || (input.expectedHeadSha && headSha !== input.expectedHeadSha)) return { found: false };
				return { found: true, value: { branch: input.branch, remote, headSha } };
			},
			perform: async () => {
				const pushed = await this.client.pushBranch(input.worktree, input.branch, remote);
				const headSha = pushed?.headSha ?? (await this.client.getBranchHead(input.branch, remote));
				if (!headSha) throw new Error("GitHub branch head is unavailable after push");
				if (input.expectedHeadSha && headSha.toLowerCase() !== input.expectedHeadSha.toLowerCase())
					throw new Error("pushed branch head does not match expected commit");
				return { branch: input.branch, remote, headSha };
			},
		});
		return result;
	}

	async createDraftPullRequest(input: DraftPullRequestInput): Promise<GitHubEffectPullRequest> {
		const operationKey = githubDraftOperationKey(input.branch, input.base, input.baseSha);
		const result = await this.executor.execute<DraftPullRequestResult>({
			operationKey,
			provider: "github",
			action: "create-draft-pull-request",
			intent: input,
			reconcile: async () => {
				const pullRequest = await this.client.findPullRequest(input.branch, input.base);
				if (pullRequest && !pullRequest.isDraft) throw new GitHubDraftConflictError(pullRequest);
				if (pullRequest) validateDraftPullRequest(input, pullRequest);
				return pullRequest ? { found: true, value: { pullRequest } } : { found: false };
			},
			perform: async () => {
				const existing = await this.client.findPullRequest(input.branch, input.base);
				if (existing) {
					if (!existing.isDraft) throw new GitHubDraftConflictError(existing);
					validateDraftPullRequest(input, existing);
					return { pullRequest: existing };
				}
				const pullRequest = await this.client.createDraftPullRequest(input);
				if (!pullRequest.isDraft) throw new Error("GitHub pull request was not created as a draft");
				validateDraftPullRequest(input, pullRequest);
				return { pullRequest };
			},
			remoteIdentifier: (value) => String(value.pullRequest.number),
		});
		return result.pullRequest;
	}

	async editPullRequest(
		reference: number | string,
		metadata: { title: string; body: string },
	): Promise<GitHubEffectPullRequest> {
		const operationKey = githubEditOperationKey(reference, metadata.title, metadata.body);
		return this.executor.execute<GitHubEffectPullRequest>({
			operationKey,
			provider: "github",
			action: "edit-pull-request",
			intent: { reference, ...metadata },
			reconcile: async () => {
				const pullRequest = await this.client.getPullRequest(reference);
				if (!pullRequest || pullRequest.title !== metadata.title || pullRequest.body !== metadata.body)
					return { found: false };
				return { found: true, value: pullRequest };
			},
			perform: async () => {
				await this.client.updatePullRequest(reference, metadata);
				const pullRequest = await this.client.getPullRequest(reference);
				if (!pullRequest) throw new Error("GitHub pull request disappeared after edit");
				return pullRequest;
			},
			remoteIdentifier: (value) => String(value.number),
		});
	}

	updatePullRequest(
		reference: number | string,
		metadata: { title: string; body: string },
	): Promise<GitHubEffectPullRequest> {
		return this.editPullRequest(reference, metadata);
	}

	async linkStack(branches: readonly string[]): Promise<void> {
		if (branches.length < 2) return;
		const operationKey = githubStackOperationKey(branches);
		await this.executor.execute<{ linked: boolean }>({
			operationKey,
			provider: "github",
			action: "link-stack",
			intent: { branches: [...branches] },
			reconcile: async () => {
				return (await this.client.isStackLinked(branches))
					? { found: true, value: { linked: true } }
					: { found: false };
			},
			perform: async () => {
				await this.client.linkStack(branches);
				return { linked: true };
			},
		});
	}

	async readyForReview(input: ReadyForReviewInput): Promise<ReadyForReviewResult> {
		if (!input.verificationPassed) throw new Error("a pull request can become ready only after passed verification");
		if (input.requiredCiPassed === false) throw new Error("required CI has not passed");
		if (!input.verifiedCommit.trim()) throw new Error("ready-for-review requires a verified commit");
		if (this.store.isEmergencyStop?.()) throw new Error("external mutations are disabled by emergency stop");
		if (!input.manifestId || !input.verificationRunId)
			throw new Error("ready-for-review requires a stored verification run");
		if (this.requireBranchLock && !this.client.acquireBranchLock)
			throw new Error("ready-for-review requires a provider branch lock");
		const verification = this.store.getReadyVerification?.(input.manifestId, input.verificationRunId);
		if (!verification) throw new Error("ready-for-review requires a current passing verification");
		if (verification.candidateSha.toLowerCase() !== input.verifiedCommit.toLowerCase())
			throw new Error("verified commit does not match the verification manifest candidate");
		if (input.expectedBaseSha && verification.baseSha.toLowerCase() !== input.expectedBaseSha.toLowerCase())
			throw new Error("verified base does not match the verification manifest base");
		const expectedBaseSha = input.expectedBaseSha ?? verification.baseSha;
		const effectiveInput: ReadyForReviewInput = { ...input, expectedBaseSha };
		for (const check of input.requiredChecks ?? [])
			if (verification.ciChecks[check] !== "pass") throw new Error(`required CI check has not passed: ${check}`);
		const current = await this.client.getPullRequest(input.reference);
		if (!current) throw new Error("GitHub pull request was not found");
		if (current.headSha?.toLowerCase() !== input.verifiedCommit.toLowerCase())
			return { status: "blocked", pullRequest: current };
		if (current.baseSha?.toLowerCase() !== expectedBaseSha.toLowerCase())
			return { status: "blocked", pullRequest: current };
		const operationKey = githubReadyOperationKey(
			input.reference,
			input.verifiedCommit,
			input.verificationRunId,
			input.requiredChecks,
			expectedBaseSha,
		);
		return this.executor.execute<ReadyForReviewResult>({
			operationKey,
			provider: "github",
			action: "ready-for-review",
			intent: effectiveInput,
			reconcile: async () => this.reconcileReady(effectiveInput),
			perform: async () => {
				const observed = await this.client.getPullRequest(input.reference);
				if (!observed) throw new Error("GitHub pull request was not found");
				const lock = this.client.acquireBranchLock
					? await this.client.acquireBranchLock(observed.branch, input.verifiedCommit)
					: undefined;
				let retainLock = false;
				try {
					const pullRequest = await this.client.getPullRequest(input.reference);
					if (!pullRequest) throw new Error("GitHub pull request was not found");
					if (pullRequest.headSha?.toLowerCase() !== input.verifiedCommit.toLowerCase())
						return { status: "blocked", pullRequest };
					if (pullRequest.baseSha?.toLowerCase() !== expectedBaseSha.toLowerCase())
						return { status: "blocked", pullRequest };
					if (!pullRequest.isDraft) return { status: "already-ready", pullRequest };
					await this.client.markReady(input.reference, {
						passed: true,
						verifiedCommit: input.verifiedCommit,
						expectedBaseSha,
						requiredCiPassed: input.requiredCiPassed ?? true,
						manifestId: input.manifestId,
						verificationRunId: input.verificationRunId,
						requiredChecks: input.requiredChecks,
					});
					const ready = await this.client.getPullRequest(input.reference);
					if (
						!ready ||
						ready.headSha?.toLowerCase() !== input.verifiedCommit.toLowerCase() ||
						ready.baseSha?.toLowerCase() !== expectedBaseSha.toLowerCase()
					)
						throw new Error("GitHub pull request SHA changed while marking ready");
					retainLock = true;
					return { status: "ready", pullRequest: ready };
				} finally {
					if (lock && !retainLock) await lock.release();
				}
			},
			remoteIdentifier: (value) => String(value.pullRequest.number),
		});
	}

	markReady(reference: number | string, boundary: VerificationBoundary): Promise<ReadyForReviewResult> {
		if (!boundary.verifiedCommit) throw new Error("ready-for-review requires a verified commit");
		return this.readyForReview({
			reference,
			verifiedCommit: boundary.verifiedCommit,
			expectedBaseSha: boundary.expectedBaseSha,
			verificationPassed: boundary.passed,
			requiredCiPassed: boundary.requiredCiPassed,
			manifestId: boundary.manifestId,
			verificationRunId: boundary.verificationRunId,
			requiredChecks: boundary.requiredChecks ?? [],
		});
	}

	private async reconcileReady(input: ReadyForReviewInput): Promise<EffectReconciliation<ReadyForReviewResult>> {
		const pullRequest = await this.client.getPullRequest(input.reference);
		if (!pullRequest) return { found: false };
		if (pullRequest.headSha?.toLowerCase() !== input.verifiedCommit.toLowerCase())
			return { found: true, value: { status: "blocked", pullRequest } };
		if (input.expectedBaseSha && pullRequest.baseSha?.toLowerCase() !== input.expectedBaseSha.toLowerCase())
			return { found: true, value: { status: "blocked", pullRequest } };
		if (!pullRequest.isDraft) return { found: true, value: { status: "already-ready", pullRequest } };
		return { found: false };
	}
}
