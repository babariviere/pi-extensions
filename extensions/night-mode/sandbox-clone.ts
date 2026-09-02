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
 *   1. `clonefile` - one recursive `clonefile(2)` on the directory. macOS only,
 *                    and the only rung that does not pay a syscall per file.
 *   2. `apfs`      - `cp -c` clone-on-write, file by file. Same result, ~5x the
 *                    wall clock on a real repository.
 *   3. `reflink`   - the same trick on Linux btrfs/XFS.
 *   4. `copy`      - a plain recursive copy. Slow, always works.
 *
 * Why the first rung exists: `cp -c -R` clones each file with its own syscall,
 * so the cost tracks the file *count*, not the size. A 3.8G repo whose tree is
 * 291k files (a colocated `.git` at 153k and `.jj` at 77k of them) took 64s
 * with `cp -c -R`, 45s with eight parallel `cp -c`, and 11.7s as a single
 * recursive `clonefile(2)` - identical file count and bytes in the result.
 * `/night start` sat there for a minute before the agent got its first turn,
 * which is why the syscall is worth reaching for.
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
import {
	accessSync,
	constants,
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

/**
 * Copies are run through the async `execFile` rather than `execFileSync`: a
 * clone of a real repository takes seconds (minutes without reflink support),
 * and doing it synchronously freezes pi's event loop for the whole duration, so
 * `/night start` looks hung rather than busy.
 */
const execFileAsync = promisify(execFile);

export const CLONE_STRATEGIES = ["clonefile", "apfs", "reflink", "copy"] as const;
export type CloneStrategy = (typeof CLONE_STRATEGIES)[number];

export interface CloneCommand {
	command: string;
	args: string[];
}

/**
 * Recursive APFS clone of a directory in one syscall.
 *
 * `clonefile(2)` clones a whole hierarchy copy-on-write when handed a
 * directory, which is what makes it ~5x faster than `cp -c -R` on a repository
 * with hundreds of thousands of files. No CLI exposes it (BSD `cp` needs `-R`
 * and then clones file by file), so it is reached through the one interpreter
 * macOS ships: a failure here - no python3, not APFS, cross-volume - is just
 * the next rung of the ladder.
 *
 * Kept as a source string rather than a script file so there is no temp file to
 * write, sandbox or clean up.
 */
export const CLONEFILE_SCRIPT = [
	"import ctypes, os, sys",
	'lib = ctypes.CDLL("/usr/lib/libSystem.dylib", use_errno=True)',
	"lib.clonefile.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint32]",
	"lib.clonefile.restype = ctypes.c_int",
	"if lib.clonefile(os.fsencode(sys.argv[1]), os.fsencode(sys.argv[2]), 0) != 0:",
	'    sys.exit("clonefile failed: %s" % os.strerror(ctypes.get_errno()))',
].join("\n");

/**
 * The invocation for a strategy. Every path is passed as an argument, never
 * interpolated into a shell string, so a path with spaces or quotes is safe.
 */
export function cloneCommand(strategy: CloneStrategy, source: string, destination: string): CloneCommand {
	if (strategy === "clonefile") {
		// clonefile creates the destination itself, so it gets the bare paths
		// rather than the `/.` contents form the `cp` rungs use.
		return { command: "python3", args: ["-c", CLONEFILE_SCRIPT, source, destination] };
	}
	const flags: Record<Exclude<CloneStrategy, "clonefile">, string[]> = {
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
	if (platform === "darwin") return ["clonefile", "apfs", "copy"];
	if (platform === "linux") return ["reflink", "copy"];
	return ["copy"];
}

/**
 * True when the strategy creates the destination itself and fails if it is
 * already there (`clonefile` returns EEXIST), rather than copying into an
 * existing directory like the `cp` rungs do.
 */
export function destinationMustBeAbsent(strategy: CloneStrategy): boolean {
	return strategy === "clonefile";
}

/**
 * Put the destination in the shape the strategy needs: the directory itself for
 * the `cp` rungs, only its parent for `clonefile`. An existing but empty
 * destination is removed (that is the normal case - the caller creates the run
 * directory before asking); a non-empty one throws, so the rung is skipped
 * instead of half-populating a directory someone else owns.
 */
function prepareDestination(strategy: CloneStrategy, destination: string): void {
	if (!destinationMustBeAbsent(strategy)) {
		mkdirSync(destination, { recursive: true });
		return;
	}
	mkdirSync(dirname(destination), { recursive: true });
	if (!existsSync(destination)) return;
	if (readdirSync(destination).length > 0) {
		throw new Error(`${destination} already exists and is not empty`);
	}
	rmSync(destination, { recursive: true, force: true });
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
		try {
			prepareDestination(strategy, destination);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			fallbacks.push(`${strategy}: ${message.split("\n")[0]}`);
			continue;
		}
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

/**
 * A private XDG config home, because jj needs to write to its own config dir.
 *
 * jj keeps a per-repository "secure config" record under
 * `$XDG_CONFIG_HOME/jj/repos/<hash>` and writes it on the first command in a
 * working copy it has not seen before. The night clone is always such a copy,
 * and the real config home sits outside the run's writable roots, so every jj
 * command in a sandboxed run dies before doing anything:
 *
 *   Internal error: Failed to determine the secure config for a repo
 *   1: Cannot access /Users/dev/.config/jj/repos/de2afa274e343353f30c
 *   2: Operation not permitted (os error 1)
 *
 * The hash is per workspace, so this hits again for every subagent workspace.
 * Redirecting `XDG_CONFIG_HOME` at a copy is the fix, and it belongs here rather
 * than in a task string every child has to be handed.
 *
 * `jj` is a real copy (it is the directory that gets written to); every sibling
 * entry is symlinked, so tools that read some other directory under
 * `XDG_CONFIG_HOME` keep their configuration, while a write through one of those
 * links still resolves outside the writable roots and is still refused.
 */
export const CONFIG_HOME_COPY_DIRS = ["jj"];

export interface PreparedConfigHome {
	/** The new config home, or undefined when there was nothing to prepare. */
	path?: string;
	/** Why it is not usable, if it is not. */
	problems: string[];
}

/**
 * Build `destination` as a config home mirroring `source` (the real
 * `XDG_CONFIG_HOME`, or `~/.config`). Never throws: a run without it is the
 * previous behaviour, a run with it can commit.
 */
export function prepareConfigHome(
	destination: string,
	opts: { source?: string; copyDirs?: string[] } = {},
): PreparedConfigHome {
	const source = opts.source ?? process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
	const copyDirs = opts.copyDirs ?? CONFIG_HOME_COPY_DIRS;
	// Nothing to work around when the tool that needs it is not configured here.
	if (!copyDirs.some((dir) => existsSync(join(source, dir)))) return { problems: [] };

	const problems: string[] = [];
	try {
		mkdirSync(destination, { recursive: true });
		for (const entry of readdirSync(source)) {
			const to = join(destination, entry);
			if (existsSync(to)) continue;
			try {
				if (copyDirs.includes(entry)) cpSync(join(source, entry), to, { recursive: true, dereference: true });
				else symlinkSync(join(source, entry), to);
			} catch (error) {
				problems.push(`config home: ${entry}: ${String(error).split("\n")[0]}`);
			}
		}
	} catch (error) {
		return { problems: [`config home: ${String(error).split("\n")[0]}`] };
	}
	return { path: destination, problems };
}

/**
 * HTTPS remotes, because the night sandbox has no SSH and no raw DNS.
 *
 * The clone inherits whatever remote the source checkout uses, which for a
 * repository cloned by hand is almost always `git@github.com:owner/repo.git`.
 * Inside the run that remote cannot work: DNS is denied at the socket layer, so
 * `ssh -T git@github.com` fails with `Could not resolve hostname github.com:
 * -65563` before authentication is even attempted. HTTPS does work (it goes
 * through the sandbox proxy) and `~/.config/git/config` already carries
 * `credential.helper = !gh auth git-credential` for `https://github.com`.
 *
 * So the fetch/push URL is rewritten at clone time, on the copy only. The
 * user's own checkout is never touched: this rewrites the throwaway working
 * copy the run was given, which is deleted in the morning.
 */

/** `git@host:owner/repo.git` and `ssh://git@host/owner/repo.git`. */
const SCP_SSH_REMOTE = /^(?:ssh:\/\/)?(?:[^@/]+@)([^:/]+)[:/](.+)$/;

/**
 * The HTTPS form of an SSH remote, or undefined when there is nothing to do
 * (already HTTPS, a local path, or a scheme we do not understand). Undefined
 * rather than a guess: a remote we cannot parse is left exactly as it was.
 */
export function httpsRemoteUrl(url: string): string | undefined {
	const trimmed = url.trim();
	if (!trimmed || trimmed.startsWith("https://") || trimmed.startsWith("http://")) return undefined;
	const match = SCP_SSH_REMOTE.exec(trimmed);
	if (!match) return undefined;
	const [, host, path] = match;
	if (!host.includes(".")) return undefined;
	return `https://${host}/${path.replace(/^\/+/, "")}`;
}

export interface RemoteRewrite {
	remote: string;
	from: string;
	to: string;
}

/**
 * How a remote is rewritten in a copy that may be a plain git repo, a jj repo,
 * or both (a colocated repo has `.git` and `.jj`).
 *
 * Both commands are issued for a colocated repo rather than just one: jj keeps
 * its own remote list in its store, and a repo where only one of the two was
 * rewritten pushes over SSH again the moment the run reaches for the other CLI.
 */
export function remoteRewriteCommands(
	path: string,
	rewrite: RemoteRewrite,
	present: { git: boolean; jj: boolean },
): PrepareCommand[] {
	const commands: PrepareCommand[] = [];
	if (present.git) {
		commands.push({
			label: `git remote set-url ${rewrite.remote}`,
			command: "git",
			args: ["-C", path, "remote", "set-url", rewrite.remote, rewrite.to],
		});
	}
	if (present.jj) {
		commands.push({
			label: `jj git remote set-url ${rewrite.remote}`,
			command: "jj",
			args: ["-R", path, "--ignore-working-copy", "git", "remote", "set-url", rewrite.remote, rewrite.to],
		});
	}
	return commands;
}

/** Parse `git remote -v` into one entry per remote, fetch URL first. */
export function parseGitRemotes(output: string): Array<{ remote: string; url: string }> {
	const seen = new Map<string, string>();
	for (const line of output.split("\n")) {
		const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line.trim());
		if (!match) continue;
		const [, remote, url, kind] = match;
		if (kind === "fetch" || !seen.has(remote)) seen.set(remote, url);
	}
	return [...seen].map(([remote, url]) => ({ remote, url }));
}

export interface RewriteRemotesResult {
	rewritten: RemoteRewrite[];
	problems: string[];
}

/**
 * Rewrite every SSH remote of the copy at `path` to its HTTPS form.
 *
 * Never throws: a repo with no remotes, no git, or a remote we cannot parse is
 * a run that pushes the way it did before, not a failed clone.
 */
export async function rewriteRemotesToHttps(
	path: string,
	opts: {
		list?: (path: string) => Promise<Array<{ remote: string; url: string }>>;
		run?: (command: PrepareCommand) => void | Promise<void>;
		present?: { git: boolean; jj: boolean };
	} = {},
): Promise<RewriteRemotesResult> {
	const present = opts.present ?? { git: existsSync(join(path, ".git")), jj: existsSync(join(path, ".jj")) };
	if (!present.git && !present.jj) return { rewritten: [], problems: [] };

	const list = opts.list ?? defaultListRemotes;
	const run =
		opts.run ??
		(async (command: PrepareCommand) => {
			await execFileAsync(command.command, command.args, { cwd: path });
		});

	let remotes: Array<{ remote: string; url: string }>;
	try {
		remotes = await list(path);
	} catch (error) {
		return { rewritten: [], problems: [`remotes: ${String(error).split("\n")[0]}`] };
	}

	const rewritten: RemoteRewrite[] = [];
	const problems: string[] = [];
	for (const { remote, url } of remotes) {
		const https = httpsRemoteUrl(url);
		if (!https) continue;
		const rewrite: RemoteRewrite = { remote, from: url, to: https };
		let failed = false;
		for (const command of remoteRewriteCommands(path, rewrite, present)) {
			try {
				await run(command);
			} catch (error) {
				failed = true;
				problems.push(`${command.label}: ${String(error).split("\n")[0]}`);
			}
		}
		if (!failed) rewritten.push(rewrite);
	}
	return { rewritten, problems };
}

const defaultListRemotes = async (path: string): Promise<Array<{ remote: string; url: string }>> => {
	const { stdout } = await execFileAsync("git", ["-C", path, "remote", "-v"]);
	return parseGitRemotes(stdout);
};
