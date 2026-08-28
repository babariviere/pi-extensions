/**
 * Per-subagent working copies for a night run.
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
 * Allocation is host side and never reachable from a model: the coordinator
 * asks for a subagent, it does not get to choose where the subagent runs.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { readNightConfig } from "./config.ts";
import { readActiveNightRun } from "./night-run.ts";
import { copyLocalFiles, prepareWorkingCopy } from "./sandbox-clone.ts";

const execFileAsync = promisify(execFile);

export interface AgentWorkspace {
	/** jj workspace name, unique within the night clone. */
	name: string;
	/** Absolute path of the workspace's working copy. */
	path: string;
	/** The night clone the workspace was added to. */
	base: string;
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
 * jj workspace name for one subagent run. jj is strict about names, so the run
 * id is reduced to its alphanumerics and the index keeps a parallel batch
 * distinct.
 */
export function agentWorkspaceName(runId: string, index: number): string {
	const short = runId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "run";
	return `agent-${short}-${index}`;
}

/** Injected for tests. Throws or rejects on failure. */
export type WorkspaceExec = (
	command: string,
	args: string[],
	cwd: string,
) => void | Promise<void>;

const defaultExec: WorkspaceExec = async (command, args, cwd) => {
	await execFileAsync(command, args, { cwd });
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
export async function acquireAgentWorkspace(
	input: AcquireInput,
): Promise<AgentWorkspace | undefined> {
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

	return { name: input.name, path, base: input.base };
}

/**
 * Give a workspace back. `jj status` first: it snapshots the working copy into
 * the shared store, so a child that edited files without committing still
 * leaves its work behind as a commit the coordinator can find. Then the
 * workspace is forgotten and its directory removed, or a night would leave one
 * checkout per subagent on disk.
 *
 * Every step is best effort. A workspace that cannot be cleaned up is disk to
 * reclaim in the morning, not a reason to fail a run that already finished.
 */
export async function releaseAgentWorkspace(
	workspace: AgentWorkspace,
	opts: { exec?: WorkspaceExec } = {},
): Promise<void> {
	const exec = opts.exec ?? defaultExec;
	try {
		await exec("jj", ["status"], workspace.path);
	} catch {
		// Nothing to snapshot, or the workspace is already broken.
	}
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
export async function acquireNightAgentWorkspace(
	name: string,
	cwd: string,
): Promise<AgentWorkspace | undefined> {
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
