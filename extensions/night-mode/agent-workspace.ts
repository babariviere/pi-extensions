/**
 * Per-subagent working copies for a night run, and the durable directory their
 * deliverables are kept in.
 *
 * The night clone (see `sandbox-clone.ts`) protects the user's checkout from the
 * run. This protects the subagents from each other: two children creating
 * changes in one working copy fight over `@`, so each one gets its own jj
 * workspace inside the night clone.
 *
 * `jj workspace add` rather than another copy, because the workspaces share the
 * clone's store: the coordinator sees every child's commits in a single
 * `jj log` of the clone instead of having to round-trip through the remote. The
 * cost is that a fresh workspace checks out tracked files only, so the local
 * config the clone was made to preserve (`mise.local.toml` and friends) is
 * copied in afterwards and the new path is trusted like any other copy.
 *
 * A workspace is deleted when the child that owned it finishes, which used to
 * mean every file the child *wrote* went with it: a subagent that produced a
 * long write-up reported the path it had written and the coordinator found the
 * directory already gone. So each workspace also gets an artifacts directory
 * beside it - outside the workspace, inside the run's writable set, and not
 * removed on release. The child is told to write its deliverables there, and
 * whatever it left in the workspace anyway is copied over before the delete.
 *
 * Allocation is host side and never reachable from a model: the coordinator
 * asks for a subagent, it does not get to choose where the subagent runs.
 */

import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { readNightConfig } from "./config.ts";
import { readActiveNightRun } from "./night-run.ts";
import { copyLocalFiles, prepareWorkingCopy } from "./sandbox-clone.ts";

const execFileAsync = promisify(execFile);

/**
 * Per-file ceiling on what is rescued out of a workspace. Sources and
 * write-ups are kilobytes; anything above this is a build product that jj only
 * reports because it is not ignored, and copying it would fill the disk of a
 * night that runs a dozen subagents.
 */
export const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;

export interface AgentWorkspace {
	/** jj workspace name, unique within the night clone. */
	name: string;
	/** Absolute path of the workspace's working copy. */
	path: string;
	/** The night clone the workspace was added to. */
	base: string;
	/**
	 * Absolute path of the workspace's deliverable directory: where the child is
	 * told to write anything that has to outlive the run, and where its workspace
	 * files are copied on release. Survives the workspace.
	 */
	artifactsDir: string;
}

/**
 * Where per-subagent workspaces live: a sibling directory of the night clone.
 *
 * Beside the clone rather than inside it, so the clone's own `jj status` does
 * not report a dozen nested workspaces as untracked files.
 */
export function agentWorkspacesRoot(clonePath: string): string {
	return `${clonePath}.agents`;
}

/**
 * The deliverable directory for one workspace: a sibling of the workspace under
 * the same root, so it is already inside the run's writable set (the root is
 * granted at `/night start`) and is not touched when the workspace directory is
 * removed.
 */
export function agentArtifactsDir(root: string, name: string): string {
	return join(root, `${name}.artifacts`);
}

/**
 * jj workspace name for one subagent run. jj is strict about names, so the run
 * id is reduced to a short hex digest and the index keeps a parallel batch
 * distinct.
 *
 * A digest rather than a slice of the id itself: run ids start with a
 * timestamp, so the first 8 alphanumerics of a night's ids are just the date
 * and every subagent of that night asked for the same workspace name. The
 * second one then collided with a directory the first had not released yet and
 * silently fell back to running in the shared clone.
 */
export function agentWorkspaceName(runId: string, index: number): string {
	const short = createHash("sha1").update(runId).digest("hex").slice(0, 8);
	return `agent-${short}-${index}`;
}

/** Injected for tests. Throws or rejects on failure. */
export type WorkspaceExec = (command: string, args: string[], cwd: string) => void | Promise<void>;

/** Injected for tests. Same contract as `WorkspaceExec`, but returns stdout. */
export type WorkspaceCapture = (command: string, args: string[], cwd: string) => string | Promise<string>;

const defaultExec: WorkspaceExec = async (command, args, cwd) => {
	await execFileAsync(command, args, { cwd });
};

const defaultCapture: WorkspaceCapture = async (command, args, cwd) => {
	const { stdout } = await execFileAsync(command, args, { cwd, maxBuffer: 8 * 1024 * 1024 });
	return stdout;
};

export interface AcquireInput {
	/** The night clone to add a workspace to. */
	base: string;
	/** Directory the workspaces are created under. */
	root: string;
	name: string;
	/** Repo-relative local files to bring over from the clone. */
	copyFiles?: string[];
	/** Run `mise trust` / `direnv allow` on the new path. */
	trust?: boolean;
	exec?: WorkspaceExec;
}

/**
 * Add a jj workspace to the night clone. Returns undefined when the clone is
 * not a jj repository or the command fails: the caller then falls back to the
 * clone itself, which is the previous behaviour rather than a dead run.
 */
export async function acquireAgentWorkspace(input: AcquireInput): Promise<AgentWorkspace | undefined> {
	if (!existsSync(join(input.base, ".jj"))) return undefined;
	const exec = input.exec ?? defaultExec;
	const path = join(input.root, input.name);
	try {
		mkdirSync(input.root, { recursive: true });
		await exec("jj", ["workspace", "add", "--name", input.name, path], input.base);
	} catch {
		return undefined;
	}

	// A fresh workspace holds tracked files only, so the untracked local config
	// the clone exists to preserve has to be brought over explicitly.
	copyLocalFiles(input.base, path, input.copyFiles ?? []);
	// Trust the new path (mise and direnv trust by path). The returned problems
	// are dropped on purpose: the only one a fresh workspace can raise is "this
	// is a secondary jj workspace", which is the whole point here.
	await prepareWorkingCopy(path, { trust: input.trust ?? true });

	const artifactsDir = agentArtifactsDir(input.root, input.name);
	// Created up front: the child is handed this path in its task message, and an
	// instruction to write into a directory that does not exist invites it to
	// give up and write next to itself instead.
	try {
		mkdirSync(artifactsDir, { recursive: true });
	} catch {
		// The copy on release recreates it per file; nothing to do here.
	}

	return { name: input.name, path, base: input.base, artifactsDir };
}

/** Statuses `jj diff --summary` uses for a path that exists in the workspace. */
const PRESENT_STATUS = /^([AMC])\s+(.+)$/;

/**
 * Repo-relative paths a `jj diff --summary` reports as still present. Deletions
 * and renames are skipped: there is nothing to copy for a `D`, and jj renders a
 * rename as a brace expression rather than a plain path.
 */
export function parseChangedPaths(summary: string): string[] {
	const paths: string[] = [];
	for (const line of summary.split("\n")) {
		const match = PRESENT_STATUS.exec(line.trim());
		if (!match) continue;
		const path = match[2].trim();
		if (!path || path.includes("=>")) continue;
		paths.push(path);
	}
	return paths;
}

/**
 * Copy everything the child changed in its workspace into the workspace's
 * artifacts directory, so a deliverable written in the working copy survives
 * the directory being deleted.
 *
 * The file list comes from `jj diff --summary -r @`, which snapshots the
 * working copy first: that covers files the child created without committing,
 * which is exactly the case that lost a 1,000-line write-up. Ignored files are
 * outside the snapshot and so outside this copy; a child that must keep one has
 * to write it to `artifactsDir` itself.
 *
 * Best effort, like the rest of release: returns the relative paths it managed
 * to copy and never throws.
 */
export async function copyWorkspaceArtifacts(
	workspace: AgentWorkspace,
	opts: { capture?: WorkspaceCapture } = {},
): Promise<string[]> {
	const capture = opts.capture ?? defaultCapture;
	let summary: string;
	try {
		summary = await capture("jj", ["--no-pager", "diff", "--summary", "-r", "@"], workspace.path);
	} catch {
		return [];
	}

	const copied: string[] = [];
	for (const relative of parseChangedPaths(summary)) {
		const from = join(workspace.path, relative);
		const to = join(workspace.artifactsDir, relative);
		try {
			const stats = statSync(from);
			if (!stats.isFile() || stats.size > MAX_ARTIFACT_BYTES) continue;
			// Never overwrite what the child wrote to the artifacts directory on
			// purpose: that copy is the intended one.
			if (existsSync(to)) continue;
			mkdirSync(dirname(to), { recursive: true });
			copyFileSync(from, to);
			copied.push(relative);
		} catch {
			// One unreadable file must not stop the rest from being rescued.
		}
	}
	return copied;
}

/**
 * Give a workspace back. `jj status` first: it snapshots the working copy into
 * the shared store, so a child that edited files without committing still
 * leaves its work behind as a commit the coordinator can find. Then the files
 * the child changed are copied into the workspace's artifacts directory, which
 * outlives it, because a commit in the store is not a path anyone can open.
 * Only then is the workspace forgotten and its directory removed, or a night
 * would leave one checkout per subagent on disk.
 *
 * Every step is best effort. A workspace that cannot be cleaned up is disk to
 * reclaim in the morning, not a reason to fail a run that already finished.
 */
export async function releaseAgentWorkspace(
	workspace: AgentWorkspace,
	opts: { exec?: WorkspaceExec; capture?: WorkspaceCapture } = {},
): Promise<void> {
	const exec = opts.exec ?? defaultExec;
	try {
		await exec("jj", ["status"], workspace.path);
	} catch {
		// Nothing to snapshot, or the workspace is already broken.
	}
	await copyWorkspaceArtifacts(workspace, opts.capture ? { capture: opts.capture } : {});
	try {
		await exec("jj", ["workspace", "forget", workspace.name], workspace.base);
	} catch {
		// Leaves a stale entry in `jj workspace list`; harmless.
	}
	try {
		rmSync(workspace.path, { recursive: true, force: true });
	} catch {
		// Disk to reclaim, not a failure.
	}
}

/**
 * Acquire a workspace for a subagent of the active night run, reading the clone
 * from the handshake and the copy/trust preferences from the night config.
 * Undefined when no run is active or the run has no clone.
 */
export async function acquireNightAgentWorkspace(name: string, cwd: string): Promise<AgentWorkspace | undefined> {
	const base = readActiveNightRun()?.workspacePath;
	if (!base) return undefined;
	const config = readNightConfig(cwd);
	return acquireAgentWorkspace({
		base,
		root: agentWorkspacesRoot(base),
		name,
		copyFiles: config.sandboxCopyFiles,
		trust: config.sandboxTrust,
	});
}
