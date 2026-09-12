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
	expectedBaseSha?: string;
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

	private async repositoryName(): Promise<{ owner: string; name: string }> {
		const result = await this.gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
		const value = result.stdout.trim();
		const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(value);
		if (!match) throw new Error("gh repo view returned an unsafe repository name");
		return { owner: match[1]!, name: match[2]! };
	}

	private async branchLockEndpoint(branch: string): Promise<string> {
		if (
			!/^[A-Za-z0-9._/-]+$/.test(branch) ||
			branch.startsWith("-") ||
			branch.includes("..") ||
			branch.includes("//") ||
			branch.startsWith("/") ||
			branch.endsWith("/")
		)
			throw new Error("invalid branch for readiness lock");
		const repository = await this.repositoryName();
		return `repos/${repository.owner}/${repository.name}/branches/${encodeURIComponent(branch)}/lock`;
	}

	private async deleteBranchLock(endpoint: string): Promise<void> {
		const args = ["api", "--method", "DELETE", endpoint];
		const result = await this.commandRunner("gh", args, { cwd: this.repository.root });
		if (result.code === 0) return;
		// GitHub returns 404 when the lock was already removed. Treat only that
		// response as successful, and retain all permission/API failures.
		if (/(?:^|\D)404(?:\D|$)|\bnot found\b/i.test(`${result.stderr}\n${result.stdout}`)) return;
		throw new GitHubCommandError(args, result);
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

	/** Acquire the GitHub provider-side branch lock and verify its protected head. */
	async acquireBranchLock(branch: string, expectedHeadSha: string): Promise<{ release: () => Promise<void> }> {
		if (!/^[0-9a-f]{40,64}$/i.test(expectedHeadSha)) throw new Error("invalid expected branch head");
		const endpoint = await this.branchLockEndpoint(branch);
		const acquireArgs = ["api", "--method", "PUT", endpoint];
		await this.gh(acquireArgs);
		try {
			const observed = await this.gh(["api", endpoint.replace(/\/lock$/, "")]);
			const parsed: unknown = JSON.parse(observed.stdout);
			const head =
				parsed &&
				typeof parsed === "object" &&
				"commit" in parsed &&
				parsed.commit &&
				typeof parsed.commit === "object" &&
				"sha" in parsed.commit
					? parsed.commit.sha
					: undefined;
			if (typeof head !== "string" || head.toLowerCase() !== expectedHeadSha.toLowerCase())
				throw new Error("provider branch head changed after readiness lock");
		} catch (error) {
			await this.deleteBranchLock(endpoint);
			throw error;
		}
		let released = false;
		let releaseInFlight: Promise<void> | undefined;
		return {
			release: async () => {
				if (released) return;
				if (!releaseInFlight) {
					releaseInFlight = (async () => {
						await this.deleteBranchLock(endpoint);
						released = true;
					})();
				}
				try {
					await releaseInFlight;
				} finally {
					if (!released) releaseInFlight = undefined;
				}
			},
		};
	}
}
