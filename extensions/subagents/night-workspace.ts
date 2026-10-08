/**
 * Cross-extension bridge: a private jj workspace per night subagent, plus the
 * durable directory its deliverables end up in.
 *
 * The coordinator asks for a subagent; it does not get to say where the child
 * runs during a night run. Caller `cwd` is rejected for night admissions;
 * request.cwd and artifactsDir remain host-only workspace overrides.
 *
 * The dependency direction matches `sandbox/night-bridge.ts`: subagents reads
 * night-mode, never the reverse.
 */

import {
	acquireNightAgentWorkspace,
	agentWorkspaceName,
	type AgentWorkspace,
	releaseAgentWorkspace,
} from "../night-mode/agent-workspace.ts";
import { readActiveNightRun, type ActiveNightRun } from "../night-mode/night-run.ts";

/** Host-only placement inputs, independent of the public subagent schema. */
export interface NightWorkspaceRequest {
	index: number;
	night?: boolean;
	cwd?: string;
	artifactsDir?: string;
}

interface WorkspaceAllocator {
	acquire?: typeof acquireNightAgentWorkspace;
	release?: typeof releaseAgentWorkspace;
}

/**
 * Give participating requests their own workspace, using one run snapshot.
 * Sequential because jj takes the repository lock. Placement is published
 * only when the whole allocation succeeds; failure releases partial workspaces
 * and never silently substitutes a shared working copy.
 */
export async function allocateNightWorkspaces(
	requests: NightWorkspaceRequest[],
	runId: string,
	cwd: string,
	run?: ActiveNightRun,
	allocator: WorkspaceAllocator = {},
): Promise<AgentWorkspace[]> {
	const snapshot = arguments.length >= 4 ? run : readActiveNightRun();
	const acquire = allocator.acquire ?? acquireNightAgentWorkspace;
	const release = allocator.release ?? releaseAgentWorkspace;
	const acquired: AgentWorkspace[] = [];
	const placements: Array<{ request: NightWorkspaceRequest; workspace: AgentWorkspace }> = [];
	try {
		for (const request of requests) {
			if (!request.night) continue;
			const workspace = await acquire(agentWorkspaceName(runId, request.index), cwd, snapshot);
			if (!workspace) {
				if (snapshot?.workspacePath) throw new Error("Night workspace isolation unavailable");
				continue;
			}
			acquired.push(workspace);
			placements.push({ request, workspace });
		}
	} catch (error) {
		await Promise.allSettled(acquired.map(async (workspace) => release(workspace)));
		throw error;
	}
	for (const { request, workspace } of placements) {
		request.cwd = workspace.path;
		request.artifactsDir = workspace.artifactsDir;
	}
	return acquired;
}

/**
 * Point every workspace path a result mentions at the surviving copy.
 *
 * A child reports the paths it wrote as it saw them, inside a working copy that
 * is deleted moments later; release copies those files into the workspace's
 * artifacts directory, so the text has to follow. Textual on purpose: the paths
 * appear in prose (`Evidence: file /...`), not in a field.
 */
export function relocateWorkspacePaths<T extends { output: string; error?: string }>(
	result: T,
	workspaces: AgentWorkspace[],
): T {
	if (workspaces.length === 0) return result;
	const rewrite = (text: string): string =>
		workspaces.reduce((acc, workspace) => acc.split(workspace.path).join(workspace.artifactsDir), text);
	return {
		...result,
		output: rewrite(result.output),
		...(result.error ? { error: rewrite(result.error) } : {}),
	};
}

/** Release every workspace a batch acquired. Never throws. */
export async function releaseNightWorkspaces(workspaces: AgentWorkspace[]): Promise<void> {
	for (const workspace of workspaces) await releaseAgentWorkspace(workspace);
}
