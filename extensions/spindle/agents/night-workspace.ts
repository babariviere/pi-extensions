/**
 * Cross-extension bridge: a private jj workspace per night subagent, plus the
 * durable directory its deliverables end up in.
 *
 * The coordinator asks for a subagent; it does not get to say where the child
 * runs. `cwd` is absent from the tool schema and from `NormalizedItem`, so the
 * only way a run gets one is here, host side, from the active night run. The
 * same is true of `artifactsDir`.
 *
 * The dependency direction matches `sandbox/night-bridge.ts`: spindle reads
 * night-mode, never the reverse.
 */

import {
	acquireNightAgentWorkspace,
	agentWorkspaceName,
	type AgentWorkspace,
	releaseAgentWorkspace,
} from "../../night-mode/agent-workspace.ts";
import type { RunRequest } from "./run.ts";

/**
 * Give every `night: true` request its own workspace, mutating its `cwd` and
 * `artifactsDir`. Sequential because `jj workspace add` takes the repository
 * lock. A request that cannot be given one keeps the parent's cwd, which is the
 * behaviour from before workspaces existed.
 */
export async function allocateNightWorkspaces(
	requests: RunRequest[],
	runId: string,
	cwd: string,
): Promise<AgentWorkspace[]> {
	const acquired: AgentWorkspace[] = [];
	for (const request of requests) {
		if (!request.night) continue;
		const workspace = await acquireNightAgentWorkspace(agentWorkspaceName(runId, request.index), cwd);
		if (!workspace) continue;
		request.cwd = workspace.path;
		request.artifactsDir = workspace.artifactsDir;
		acquired.push(workspace);
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
