import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";

export interface CommandOptions {
	cwd?: string;
	env?: Record<string, string | undefined>;
}

export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

export type CommandRunner = (executable: string, args: string[], options?: CommandOptions) => Promise<CommandResult>;

export const spawnCommandRunner: CommandRunner = (executable, args, options = {}) =>
	new Promise((resolveResult, reject) => {
		const child = spawn(executable, args, {
			cwd: options.cwd,
			env: options.env === undefined ? undefined : { ...process.env, ...options.env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
		child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
		child.once("error", reject);
		child.once("close", (code) => resolveResult({ code: code ?? 1, stdout, stderr }));
	});

export class GitCommandError extends Error {
	constructor(
		readonly executable: string,
		readonly args: readonly string[],
		readonly result: CommandResult,
	) {
		super(`${executable} ${args.join(" ")} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
		this.name = "GitCommandError";
	}
}

export interface RepositoryDetails {
	primaryCheckout: string;
	gitDir: string;
	gitCommonDir: string;
}

/** Git operations owned by the controller. The primary checkout is never used for checkout/reset/clean. */
export class GitRepository {
	private static readonly locks = new Map<string, Promise<void>>();
	private details?: RepositoryDetails;
	readonly root: string;

	constructor(
		root: string,
		readonly runner: CommandRunner = spawnCommandRunner,
	) {
		if (!root.trim()) throw new Error("repository root must be non-empty");
		this.root = resolve(root);
	}

	private async lockKey(): Promise<string> {
		try {
			return await realpath(this.root);
		} catch {
			return this.root;
		}
	}

	/** Serialize all mutations that touch refs, worktree metadata, or objects for this repository. */
	async withMutation<T>(operation: () => Promise<T>): Promise<T> {
		const key = await this.lockKey();
		const previous = GitRepository.locks.get(key) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>((resolveRelease) => (release = resolveRelease));
		GitRepository.locks.set(key, current);
		await previous;
		try {
			return await operation();
		} finally {
			release();
			if (GitRepository.locks.get(key) === current) GitRepository.locks.delete(key);
		}
	}

	async detailsOf(): Promise<RepositoryDetails> {
		if (this.details) return this.details;
		const top = await this.checked(["rev-parse", "--show-toplevel"]);
		const gitDir = await this.checked(["rev-parse", "--git-dir"]);
		const common = await this.checked(["rev-parse", "--git-common-dir"]);
		const bare = await this.checked(["rev-parse", "--is-bare-repository"]);
		if (bare.trim() === "true") throw new Error("background work requires a non-bare Git repository");
		this.details = {
			primaryCheckout: await realpath(top.trim()),
			gitDir: resolve(this.root, gitDir.trim()),
			gitCommonDir: resolve(this.root, common.trim()),
		};
		return this.details;
	}

	async command(args: string[], cwd?: string): Promise<CommandResult> {
		return this.runner("git", ["-C", cwd ?? this.root, ...args], {});
	}

	async checked(args: string[], cwd?: string): Promise<string> {
		const result = await this.command(args, cwd);
		if (result.code !== 0) throw new GitCommandError("git", args, result);
		return result.stdout;
	}

	async branchExists(branch: string): Promise<boolean> {
		const result = await this.command(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
		return result.code === 0;
	}

	async branchCommit(branch: string): Promise<string> {
		return (await this.checked(["rev-parse", `${branch}^{commit}`])).trim();
	}

	/** Make a private object/ref store. No worker process receives the primary .git. */
	async cloneForAttempt(destination: string): Promise<GitRepository> {
		if (resolve(destination) === this.root) throw new Error("isolated Git repository must differ from primary");
		await mkdir(resolve(destination), { recursive: true });
		const args = ["clone", "--no-hardlinks", "--no-local", this.root, resolve(destination)];
		const result = await this.runner("git", args, {});
		if (result.code !== 0) throw new GitCommandError("git", args, result);
		return new GitRepository(resolve(destination), this.runner);
	}

	/** Validate and import one exact candidate object into the durable repository. */
	async importCommit(worktree: string, branch: string, candidateSha: string, expectedBaseSha: string): Promise<void> {
		if (!/^[0-9a-f]{40,64}$/i.test(candidateSha) || !/^[0-9a-f]{40,64}$/i.test(expectedBaseSha))
			throw new Error("Git import requires full object IDs");
		if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith("-") || branch.includes(".."))
			throw new Error("invalid branch for Git import");
		await this.withMutation(async () => {
			const sourceResult = await this.command(["rev-parse", "--verify", `${candidateSha}^{commit}`], worktree);
			if (sourceResult.code !== 0)
				throw new GitCommandError("git", ["rev-parse", "--verify", `${candidateSha}^{commit}`], sourceResult);
			const source = sourceResult.stdout.trim();
			if (source.toLowerCase() !== candidateSha.toLowerCase()) throw new Error("candidate Git object is not exact");
			const tempRef = `refs/background-import/${randomUUID()}`;
			const fetchArgs = ["fetch", "--no-tags", "--no-write-fetch-head", worktree, `${candidateSha}:${tempRef}`];
			const fetched = await this.command(fetchArgs);
			if (fetched.code !== 0) throw new GitCommandError("git", fetchArgs, fetched);
			try {
				const checked = await this.command(["cat-file", "-e", `${candidateSha}^{commit}`]);
				if (checked.code !== 0)
					throw new GitCommandError("git", ["cat-file", "-e", `${candidateSha}^{commit}`], checked);
				const ancestry = await this.command(["merge-base", "--is-ancestor", expectedBaseSha, candidateSha]);
				if (ancestry.code !== 0)
					throw new GitCommandError(
						"git",
						["merge-base", "--is-ancestor", expectedBaseSha, candidateSha],
						ancestry,
					);
				const current = await this.command(["rev-parse", "--verify", `${branch}^{commit}`]);
				if (current.code === 0 && current.stdout.trim().toLowerCase() === candidateSha.toLowerCase()) return;
				if (current.code === 0 && current.stdout.trim().toLowerCase() !== expectedBaseSha.toLowerCase())
					throw new Error("durable branch no longer points at the assigned base");
				const updateArgs = [
					"update-ref",
					`refs/heads/${branch}`,
					candidateSha,
					current.code === 0 ? expectedBaseSha : "",
				];
				const updated = await this.command(updateArgs);
				if (updated.code !== 0) {
					const after = await this.command(["rev-parse", "--verify", `${branch}^{commit}`]);
					if (after.code !== 0 || after.stdout.trim().toLowerCase() !== candidateSha.toLowerCase())
						throw new GitCommandError("git", updateArgs, updated);
				}
			} finally {
				await this.command(["update-ref", "-d", tempRef]);
			}
		});
	}

	async listBranches(prefix = ""): Promise<string[]> {
		if (prefix.includes("..") || prefix.startsWith("-")) throw new Error("invalid branch prefix");
		const output = await this.checked(["for-each-ref", "--format=%(refname:short)", `refs/heads/${prefix}`]);
		return output
			.split("\n")
			.map((branch) => branch.trim())
			.filter(Boolean);
	}

	/** Pushes only a controller-owned worktree. The primary checkout cannot be pushed accidentally. */
	async push(worktree: string, branch: string, remote = "origin"): Promise<void> {
		const details = await this.detailsOf();
		if ((await realpath(worktree)) === details.primaryCheckout) throw new Error("the primary checkout is read-only");
		await this.withMutation(async () => {
			const result = await this.command(["push", "--set-upstream", remote, branch], worktree);
			if (result.code !== 0) throw new GitCommandError("git", ["push", "--set-upstream", remote, branch], result);
		});
	}
}
