import { backgroundBranch, GitWorktreeManager, type WorktreeRecord } from "./worktree.ts";
import { GitHubController, type GitHubPullRequest, type VerificationBoundary } from "./github.ts";

export interface StackItemInput {
	caseId: string;
	ordinal: number;
	owner: string;
	title: string;
	body: string;
}

export interface StackItemResult {
	item: StackItemInput;
	branch: string;
	base: string;
	worktree: WorktreeRecord;
	pullRequest: GitHubPullRequest;
	verification: VerificationBoundary;
}

export interface StackDeliveryOptions {
	baseBranch: string;
	verify: (input: {
		item: StackItemInput;
		branch: string;
		base: string;
		worktree: WorktreeRecord;
		pullRequest: GitHubPullRequest;
		parent?: StackItemResult;
	}) => Promise<VerificationBoundary>;
}

function validateItems(items: readonly StackItemInput[]): void {
	const owners = new Set<string>();
	const ordinals = new Set<number>();
	for (const item of items) {
		if (!Number.isSafeInteger(item.ordinal) || item.ordinal <= 0)
			throw new Error("stack ordinals must be positive integers");
		if (owners.has(item.owner)) throw new Error(`stack owner is not unique: ${item.owner}`);
		if (ordinals.has(item.ordinal)) throw new Error(`stack ordinal is not unique: ${item.ordinal}`);
		owners.add(item.owner);
		ordinals.add(item.ordinal);
	}
}

/** Delivers one linear stack. There is deliberately no merge operation here. */
export class GitStackController {
	constructor(
		readonly worktrees: GitWorktreeManager,
		readonly github: GitHubController,
	) {}

	async deliver(items: readonly StackItemInput[], options: StackDeliveryOptions): Promise<StackItemResult[]> {
		validateItems(items);
		if (!options.baseBranch.trim()) throw new Error("baseBranch must be non-empty");
		const ordered = [...items].sort((a, b) => a.ordinal - b.ordinal);
		const results: StackItemResult[] = [];

		for (const item of ordered) {
			const parent = results.at(-1);
			if (parent) {
				if (!parent.verification.passed || parent.verification.requiredCiPassed === false)
					throw new Error(
						`stack item ${item.ordinal} cannot start before item ${parent.item.ordinal} is verified`,
					);
				if (!parent.verification.verifiedCommit?.trim())
					throw new Error(`stack item ${item.ordinal} requires a verified parent commit`);
			}
			const base = parent?.branch ?? options.baseBranch;
			const branch = backgroundBranch(item.caseId, item.ordinal);
			const worktree = await this.worktrees.ensure({
				caseId: item.caseId,
				ordinal: item.ordinal,
				owner: item.owner,
				baseRef: base,
			});
			await this.github.pushBranch(worktree.path, branch);
			const pullRequest = await this.github.createDraftPullRequest({
				worktree: worktree.path,
				branch,
				base,
				title: item.title,
				body: item.body,
			});
			await this.github.updatePullRequest(pullRequest.number, { title: item.title, body: item.body });
			const verification = await options.verify({
				item,
				branch,
				base,
				worktree,
				pullRequest,
				...(parent ? { parent } : {}),
			});
			if (!verification.passed) throw new Error(`verification failed for stack item ${item.ordinal}`);
			await this.github.markReady(pullRequest.number, verification);
			results.push({ item, branch, base, worktree, pullRequest, verification });
		}

		await this.github.linkStack(results.map((result) => result.branch));
		return results;
	}

	/** Reconcile known stack branches without removing or cleaning any checkout. */
	async reconcile(caseId: string, ordinals: readonly number[]): Promise<WorktreeRecord[]> {
		const expected = new Set(ordinals.map((ordinal) => backgroundBranch(caseId, ordinal)));
		return (await this.worktrees.reconcile()).filter(
			(record) => record.branch !== undefined && expected.has(record.branch),
		);
	}
}
