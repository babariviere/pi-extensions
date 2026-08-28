/**
 * Cross-extension bridge: a private jj workspace per night subagent.
 *
 * The coordinator asks for a subagent; it does not get to say where the child
 * runs. `cwd` is absent from the tool schema and from `NormalizedItem`, so the
 * only way a run gets one is here, host side, from the active night run.
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
 * Give every `night: true` request its own workspace, mutating its `cwd`.
 * Sequential because `jj workspace add` takes the repository lock. A request
 * that cannot be given one keeps the parent's cwd, which is the behaviour from
 * before workspaces existed.
 */
export async function allocateNightWorkspaces(
	requests: RunRequest[],
	runId: string,
	cwd: string,
): Promise<AgentWorkspace[]> {
	const acquired: AgentWorkspace[] = [];
	for (const request of requests) {
		if (!request.night) continue;
		const workspace = await acquireNightAgentWorkspace(
			agentWorkspaceName(runId, request.index),
			cwd,
		);
		if (!workspace) continue;
		request.cwd = workspace.path;
		acquired.push(workspace);
	}
	return acquired;
}

/** Release every workspace a batch acquired. Never throws. */
export async function releaseNightWorkspaces(
	workspaces: AgentWorkspace[],
): Promise<void> {
	for (const workspace of workspaces) await releaseAgentWorkspace(workspace);
}
