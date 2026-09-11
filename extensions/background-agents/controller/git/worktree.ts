import { mkdir, realpath, stat } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { GitCommandError, GitRepository } from "./repository.ts";

export interface WorktreeRecord {
	path: string;
	branch?: string;
	head?: string;
	dirty: boolean;
	missing?: boolean;
}

export interface EnsureWorktreeInput {
	caseId: string;
	ordinal: number;
	owner: string;
	baseRef: string;
}

export function backgroundBranch(caseId: string, ordinal: number): string {
	if (!/^[A-Za-z0-9._-]+$/.test(caseId) || caseId === "." || caseId === "..")
		throw new Error("caseId must be a single safe Git branch path segment");
	if (!Number.isSafeInteger(ordinal) || ordinal <= 0) throw new Error("ordinal must be a positive integer");
	return `background/${caseId}/${ordinal}`;
}

function required(value: string, field: string): string {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be non-empty`);
	return value.trim();
}

function parseWorktrees(text: string, root: string): Array<{ path: string; branch?: string; head?: string }> {
	const records: Array<{ path: string; branch?: string; head?: string }> = [];
	let current: { path: string; branch?: string; head?: string } | undefined;
	const finish = () => {
		if (current) records.push(current);
		current = undefined;
	};
	for (const line of text.split("\n")) {
		if (line === "") {
			finish();
			continue;
		}
		if (line.startsWith("worktree ")) {
			finish();
			current = { path: resolve(root, line.slice("worktree ".length)) };
		} else if (current && line.startsWith("HEAD ")) current.head = line.slice(5).trim();
		else if (current && line.startsWith("branch refs/heads/"))
			current.branch = line.slice("branch refs/heads/".length).trim();
	}
	finish();
	return records;
}

export class GitWorktreeManager {
	private readonly owners = new Map<string, string>();

	constructor(
		readonly repository: GitRepository,
		readonly worktreeRoot: string,
	) {
		if (!worktreeRoot.trim()) throw new Error("worktreeRoot must be non-empty");
	}

	private async listed(): Promise<Array<{ path: string; branch?: string; head?: string }>> {
		const records = parseWorktrees(
			await this.repository.checked(["worktree", "list", "--porcelain"]),
			this.repository.root,
		);
		return Promise.all(
			records.map(async (record) => ({
				...record,
				path: await realpath(record.path).catch(() => resolve(record.path)),
			})),
		);
	}

	private async inspect(record: { path: string; branch?: string; head?: string }): Promise<WorktreeRecord> {
		const exists = await stat(record.path)
			.then(() => true)
			.catch(() => false);
		if (!exists) return { ...record, dirty: false, missing: true };
		const status = await this.repository.command(["status", "--porcelain", "--untracked-files=all"], record.path);
		if (status.code !== 0)
			throw new GitCommandError("git", ["status", "--porcelain", "--untracked-files=all"], status);
		return { ...record, dirty: status.stdout.length > 0 };
	}

	/** Reconcile Git's worktree registry without deleting or cleaning anything. */
	async reconcile(): Promise<WorktreeRecord[]> {
		return Promise.all((await this.listed()).map((record) => this.inspect(record)));
	}

	async reconcileBranches(caseId: string): Promise<string[]> {
		backgroundBranch(caseId, 1);
		return this.repository.listBranches(`background/${caseId}/`);
	}

	async ensure(input: EnsureWorktreeInput): Promise<WorktreeRecord> {
		const caseId = required(input.caseId, "caseId");
		const owner = required(input.owner, "owner");
		const baseRef = required(input.baseRef, "baseRef");
		const branch = backgroundBranch(caseId, input.ordinal);
		const priorOwnerPath = this.owners.get(owner);

		return this.repository.withMutation(async () => {
			const primary = (await this.repository.detailsOf()).primaryCheckout;
			const worktreeRoot = resolve(this.worktreeRoot);
			const fromPrimary = relative(primary, worktreeRoot);
			if (fromPrimary === "" || (!fromPrimary.startsWith("..") && !isAbsolute(fromPrimary)))
				throw new Error("worktrees must be outside the primary checkout");
			await mkdir(this.worktreeRoot, { recursive: true });
			const path = resolve(await realpath(this.worktreeRoot), caseId, String(input.ordinal));
			if (priorOwnerPath && priorOwnerPath !== path)
				throw new Error(`owner ${owner} already owns ${priorOwnerPath}`);
			const records = await this.listed();
			const byPath = records.find((record) => record.path === path);
			const byBranch = records.find((record) => record.branch === branch);
			if (byBranch && byBranch.path !== path)
				throw new Error(`branch ${branch} is already attached to ${byBranch.path}`);
			if (byPath && byPath.branch !== branch)
				throw new Error(`worktree ${path} is attached to ${byPath.branch ?? "a detached HEAD"}`);

			if (!byPath) {
				const onDisk = await stat(path)
					.then(() => true)
					.catch(() => false);
				if (onDisk) throw new Error(`refusing to replace unregistered worktree path ${path}`);
				await mkdir(resolve(this.worktreeRoot, caseId), { recursive: true });
				const args = (await this.repository.branchExists(branch))
					? ["worktree", "add", path, branch]
					: ["worktree", "add", "-b", branch, path, baseRef];
				const result = await this.repository.command(args);
				if (result.code !== 0) throw new GitCommandError("git", args, result);
			}
			this.owners.set(owner, path);
			const current = (await this.listed()).find((record) => record.path === path);
			if (!current) throw new Error(`Git did not register worktree ${path}`);
			return this.inspect(current);
		});
	}

	/** This intentionally has no remove/clean operation. Dirty worker worktrees survive restarts. */
	async status(path: string): Promise<WorktreeRecord> {
		const canonicalPath = await realpath(path).catch(() => resolve(path));
		const record = (await this.listed()).find((candidate) => candidate.path === canonicalPath);
		if (!record) throw new Error(`Unknown Git worktree: ${path}`);
		return this.inspect(record);
	}
}
