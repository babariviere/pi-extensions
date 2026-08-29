/**
 * Per-run working copies for a night run.
 *
 * The agent gets its own checkout instead of the one you left open, so an
 * unattended run cannot dirty, stash or reset your working tree. Combined with
 * Spindle's sandbox (see `spindle/sandbox/`), which makes everything outside
 * that copy unwritable, an overnight mistake is contained to a directory you
 * can delete in the morning.
 *
 * Copy strategy is a ladder, because the cheap options are filesystem- and
 * VCS-specific and every one of them can fail on a given machine:
 *
 *   1. `apfs`     - `cp -c` clone-on-write. Instant on macOS, keeps ignored
 *                   files, build outputs and `.git`/`.jj` intact.
 *   2. `reflink`  - the same trick on Linux btrfs/XFS.
 *   3. `copy`     - a plain recursive copy. Slow, always works.
 *
 * `cp -a --link` used to sit between reflink and copy. It is gone: hardlinks
 * share the inode, so a tool that rewrites a file in place (rather than writing
 * a temp file and renaming) edits the original through the clone, which is the
 * exact failure this module exists to prevent. On a filesystem without reflink
 * support the ladder now drops straight to a real copy: slower, but the
 * isolation guarantee holds everywhere.
 *
 * The VCS-level options (`jj workspace add`, `git clone --shared`) are
 * deliberately NOT in the ladder: they drop untracked and ignored files, which
 * is exactly where local credentials and toolchain config live (`mise.local.toml`,
 * gitignored key material), and a run that silently loses them fails in a way
 * that looks like a broken repo rather than a broken copy.
 */

import { execFile } from "node:child_process";
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

/**
 * Copies are run through the async `execFile` rather than `execFileSync`: a
 * clone of a real repository takes seconds (minutes without reflink support),
 * and doing it synchronously freezes pi's event loop for the whole duration, so
 * `/night start` looks hung rather than busy.
 */
const execFileAsync = promisify(execFile);

export const CLONE_STRATEGIES = ["apfs", "reflink", "copy"] as const;
export type CloneStrategy = (typeof CLONE_STRATEGIES)[number];

export interface CloneCommand {
	command: string;
	args: string[];
}

/**
 * The `cp` invocation for a strategy. Both paths are passed as arguments, never
 * interpolated into a shell string, so a path with spaces or quotes is safe.
 */
export function cloneCommand(strategy: CloneStrategy, source: string, destination: string): CloneCommand {
	const flags: Record<CloneStrategy, string[]> = {
		apfs: ["-c", "-R", "-p"],
		reflink: ["-a", "--reflink=always"],
		copy: ["-R", "-p"],
	};
	// Trailing `/.` copies the directory's contents into an existing destination,
	// which keeps every strategy's result shape identical.
	return { command: "cp", args: [...flags[strategy], `${source}/.`, destination] };
}

/** Strategies to try, best first, for a platform. */
export function strategyOrder(platform: NodeJS.Platform): CloneStrategy[] {
	if (platform === "darwin") return ["apfs", "copy"];
	if (platform === "linux") return ["reflink", "copy"];
	return ["copy"];
}

/** `<root>/<repo>/<stamp>`, the layout `workspaces` already uses for jj workspaces. */
export function sandboxPathFor(root: string, source: string, stamp: string): string {
	return join(root, basename(source), stamp);
}

export interface CreateSandboxInput {
	/** Working copy to clone. */
	source: string;
	/** Destination directory; created if missing, must be empty or absent. */
	destination: string;
	/** Repo-relative files to copy in afterwards, for strategies that lose them. */
	copyFiles?: string[];
	platform?: NodeJS.Platform;
	/** Injected for tests. Throws or rejects on failure. */
	run?: (command: CloneCommand) => void | Promise<void>;
}

export interface CreatedSandbox {
	path: string;
	strategy: CloneStrategy;
	/** Strategies that failed before the one that worked, with their errors. */
	fallbacks: string[];
}

const defaultRun = async (command: CloneCommand): Promise<void> => {
	await execFileAsync(command.command, command.args);
};

/**
 * Clone `source` into `destination`, trying each strategy in turn. Rejects only
 * when every strategy fails, with all the failures in the message: a silent
 * fallback to "no sandbox" would be worse than not starting the run.
 *
 * Async so the copy does not block the caller's event loop.
 */
export async function createRunSandbox(input: CreateSandboxInput): Promise<CreatedSandbox> {
	const { source, destination } = input;
	if (!existsSync(source)) throw new Error(`night-mode: source ${source} does not exist`);

	const run = input.run ?? defaultRun;
	const platform = input.platform ?? process.platform;
	const fallbacks: string[] = [];

	for (const strategy of strategyOrder(platform)) {
		mkdirSync(destination, { recursive: true });
		try {
			await run(cloneCommand(strategy, source, destination));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			fallbacks.push(`${strategy}: ${message.split("\n")[0]}`);
			// A partial copy would make the next strategy's `cp` fail on existing
			// files, so clear the destination before retrying.
			try {
				rmSync(destination, { recursive: true, force: true });
			} catch {
				// Leave it; the next mkdirSync will surface a real problem.
			}
			continue;
		}
		copyLocalFiles(source, destination, input.copyFiles ?? []);
		return { path: destination, strategy, fallbacks };
	}

	throw new Error(`night-mode: could not clone ${source} into ${destination} (${fallbacks.join("; ")})`);
}

/**
 * Per-path trust: the part a naive copy gets wrong.
 *
 * `mise` and `direnv` trust config files **by path**, so a fresh copy is
 * untrusted no matter that the original was. mise does not warn and continue, it
 * hard-fails:
 *
 *   mise ERROR Config files in <clone>/mise.toml are not trusted.
 *
 * Every `mise exec`, `mise run` and task in the new copy would fail, which looks
 * like a broken repo rather than a missing trust record. So the copy is trusted
 * right after it is made, from the extension (i.e. the host process) rather than
 * from a sandboxed shell, because the trust stores live outside the run's
 * writable roots.
 */

/** Config file names that make a directory a mise project. */
const MISE_CONFIG_FILES = ["mise.toml", "mise.local.toml", ".mise.toml", ".mise.local.toml"];

export interface PrepareCommand {
	label: string;
	command: string;
	args: string[];
}

export interface PrepareInput {
	/** The fresh working copy. */
	path: string;
	/** True when the copy has a mise config at its root. */
	hasMiseConfig: boolean;
	/** True when the copy has an `.envrc`. */
	hasEnvrc: boolean;
	/** Tools present on PATH; a missing tool means its step is skipped. */
	available: { mise?: boolean; direnv?: boolean };
}

/**
 * The trust commands a fresh copy needs. `mise trust --all` is used rather than
 * one call per file because a repo can carry nested configs (task dirs,
 * `mise.<env>.toml`), and missing one of them fails at the worst moment.
 */
export function prepareCommands(input: PrepareInput): PrepareCommand[] {
	const commands: PrepareCommand[] = [];
	if (input.hasMiseConfig && input.available.mise !== false) {
		commands.push({
			label: "mise trust",
			command: "mise",
			args: ["trust", "--all", "--yes", "--quiet", "-C", input.path],
		});
	}
	if (input.hasEnvrc && input.available.direnv !== false) {
		commands.push({
			label: "direnv allow",
			command: "direnv",
			args: ["allow", input.path],
		});
	}
	return commands;
}

/**
 * Problems that make a copy *not* independent, which no amount of trusting fixes.
 *
 * A git linked worktree keeps `.git` as a file pointing at the original repo, and
 * a secondary jj workspace keeps `.jj/repo` as a file pointing at the original
 * store. Copying either produces a directory that still writes into the repo you
 * were trying to protect, and whose store sits outside the run's writable roots,
 * so VCS commands fail in a confusing way. Both are reported so the run can say
 * so instead of silently misbehaving.
 */
export function detectSharedStateWarnings(path: string): string[] {
	const warnings: string[] = [];
	const isFile = (candidate: string): boolean => {
		try {
			return statSync(candidate).isFile();
		} catch {
			return false;
		}
	};
	if (isFile(join(path, ".git"))) {
		warnings.push(
			"the source is a git linked worktree (.git is a pointer file), so the copy still shares the original repository",
		);
	}
	if (isFile(join(path, ".jj", "repo"))) {
		warnings.push(
			"the source is a secondary jj workspace (.jj/repo is a pointer file), so the copy still shares the original store",
		);
	}
	return warnings;
}

export interface PreparedWorkingCopy {
	/** Labels of the steps that ran successfully. */
	ran: string[];
	/** `label: reason` for steps that failed, and shared-state warnings. */
	problems: string[];
}

/**
 * Make a fresh copy usable: trust its config files, then report anything that
 * makes it less isolated than it looks. Never rejects; a failed trust step is a
 * degraded run, not a dead one.
 */
export async function prepareWorkingCopy(
	path: string,
	opts: {
		trust?: boolean;
		run?: (command: PrepareCommand) => void | Promise<void>;
		lookup?: (tool: string) => boolean;
	} = {},
): Promise<PreparedWorkingCopy> {
	const problems = detectSharedStateWarnings(path);
	if (opts.trust === false) return { ran: [], problems };

	const run =
		opts.run ??
		(async (command: PrepareCommand) => {
			await execFileAsync(command.command, command.args, { cwd: path });
		});
	const lookup = opts.lookup ?? onPath;
	const commands = prepareCommands({
		path,
		hasMiseConfig: MISE_CONFIG_FILES.some((file) => existsSync(join(path, file))),
		hasEnvrc: existsSync(join(path, ".envrc")),
		available: { mise: lookup("mise"), direnv: lookup("direnv") },
	});

	const ran: string[] = [];
	for (const command of commands) {
		try {
			await run(command);
			ran.push(command.label);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			problems.push(`${command.label}: ${message.split("\n")[0]}`);
		}
	}
	return { ran, problems };
}

/**
 * Walk `PATH` looking for an executable. Done in-process rather than by shelling
 * out to `command -v`, which would either need `shell: true` (deprecated in Node
 * for argument-bearing calls) or interpolation into a shell string.
 */
function onPath(tool: string): boolean {
	const entries = (process.env.PATH ?? "").split(":").filter(Boolean);
	return entries.some((entry) => {
		try {
			accessSync(join(entry, tool), constants.X_OK);
			return true;
		} catch {
			return false;
		}
	});
}

/**
 * Copy configured extra files, ignoring ones that are absent or already there.
 *
 * Exported because a fresh jj workspace has the same gap as a copy strategy that
 * loses untracked files: see `agent-workspace.ts`.
 */
export function copyLocalFiles(source: string, destination: string, files: string[]): void {
	for (const relative of files) {
		const from = join(source, relative);
		const to = join(destination, relative);
		if (!existsSync(from) || existsSync(to)) continue;
		try {
			mkdirSync(dirname(to), { recursive: true });
			copyFileSync(from, to);
		} catch {
			// Best effort: a missing local config is a degraded run, not a failed one.
		}
	}
}
