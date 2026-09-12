import type { CommandResult } from "./repository.ts";
import { GitRepository, type CommandRunner } from "./repository.ts";

export interface GitHubPullRequest {
	number: number;
	url: string;
	branch: string;
	base: string;
	isDraft: boolean;
	headSha?: string;
	baseSha?: string;
	title?: string;
	body?: string;
}

export interface VerificationBoundary {
	passed: boolean;
	verifiedCommit?: string;
	requiredCiPassed?: boolean;
	manifestId?: string;
	verificationRunId?: string;
	requiredChecks?: readonly string[];
}

export interface DraftPullRequestInput {
	worktree: string;
	branch: string;
	base: string;
	baseSha?: string;
	title: string;
	body: string;
}

export class GitHubCommandError extends Error {
	constructor(
		readonly args: readonly string[],
		readonly result: CommandResult,
	) {
		super(`gh ${args.join(" ")} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
		this.name = "GitHubCommandError";
	}
}

function jsonObject(text: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(text);
		return value !== null && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function stringField(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`GitHub response is missing ${field}`);
	return value;
}

function numberField(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
		throw new Error("GitHub response has an invalid PR number");
	return value;
}

/** All GitHub mutations used by background workers go through this controller. */
export class GitHubController {
	private readonly commandRunner: CommandRunner;

	constructor(
		readonly repository: GitRepository,
		runner: CommandRunner = repository.runner,
	) {
		this.commandRunner = runner;
	}

	private async gh(args: string[]): Promise<CommandResult> {
		const result = await this.commandRunner("gh", args, { cwd: this.repository.root });
		if (result.code !== 0) throw new GitHubCommandError(args, result);
		return result;
	}

	async pushBranch(worktree: string, branch: string, remote = "origin"): Promise<void> {
		await this.repository.push(worktree, branch, remote);
	}

	async createDraftPullRequest(input: DraftPullRequestInput): Promise<GitHubPullRequest> {
		const args = [
			"pr",
			"create",
			"--draft",
			"--base",
			input.base,
			"--head",
			input.branch,
			"--title",
			input.title,
			"--body",
			input.body,
		];
		const result = await this.gh(args);
		const created = jsonObject(result.stdout.trim());
		if (created && created.number !== undefined) return this.pullRequestFrom(created, input.branch, input.base);
		const url = result.stdout.trim().match(/https?:\/\/\S+/)?.[0];
		if (!url) throw new Error("gh pr create did not return a pull request URL or JSON object");
		const viewed = await this.gh([
			"pr",
			"view",
			input.branch,
			"--json",
			"number,url,isDraft,headRefName,baseRefName,headRefOid,baseRefOid,title,body",
		]);
		const details = jsonObject(viewed.stdout.trim());
		if (!details) throw new Error("gh pr view returned invalid JSON");
		return this.pullRequestFrom({ ...details, url }, input.branch, input.base);
	}

	private pullRequestFrom(value: Record<string, unknown>, branch: string, base: string): GitHubPullRequest {
		return {
			number: numberField(value.number),
			url: stringField(value.url, "url"),
			branch: typeof value.headRefName === "string" ? value.headRefName : branch,
			base: typeof value.baseRefName === "string" ? value.baseRefName : base,
			isDraft: value.isDraft === undefined ? true : value.isDraft === true,
			...(typeof value.headRefOid === "string" ? { headSha: value.headRefOid } : {}),
			...(typeof value.baseRefOid === "string" ? { baseSha: value.baseRefOid } : {}),
			...(typeof value.title === "string" ? { title: value.title } : {}),
			...(typeof value.body === "string" ? { body: value.body } : {}),
		};
	}

	async getPullRequest(reference: number | string): Promise<GitHubPullRequest | null> {
		const args = [
			"pr",
			"view",
			String(reference),
			"--json",
			"number,url,isDraft,headRefName,baseRefName,headRefOid,baseRefOid,title,body",
		];
		const result = await this.commandRunner("gh", args, { cwd: this.repository.root });
		if (result.code !== 0) {
			if (/not found|could not resolve to a pull request|no pull request/i.test(result.stderr)) return null;
			throw new GitHubCommandError(args, result);
		}
		const details = jsonObject(result.stdout.trim());
		if (!details) throw new Error("gh pr view returned invalid JSON");
		return this.pullRequestFrom(details, typeof details.headRefName === "string" ? details.headRefName : "", "");
	}

	async findPullRequest(branch: string, base: string): Promise<GitHubPullRequest | null> {
		const pullRequest = await this.getPullRequest(branch);
		return pullRequest && pullRequest.base === base ? pullRequest : null;
	}

	async updatePullRequest(reference: number | string, metadata: { title: string; body: string }): Promise<void> {
		await this.gh(["pr", "edit", String(reference), "--title", metadata.title, "--body", metadata.body]);
	}

	/** Branches must be supplied in bottom-to-top order. */
	async linkStack(branches: readonly string[]): Promise<void> {
		if (branches.length < 2) return;
		await this.gh(["stack", "link", ...branches]);
	}
}
