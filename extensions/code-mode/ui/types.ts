/** The above-editor widget tracks only session-owned jobs and subagents. */
import type { JobSnapshot } from "../providers/jobs-provider.ts";

/** Token counters read by `ui/widget.ts`; local stand-in for upstream `AgentUsage`. */
export interface CodeModeUiAgentUsage {
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: number;
}

export interface CodeModeUiAgent {
	id: string;
	name: string;
	status: string;
	currentTool?: string;
	startedAt?: number;
	updatedAt?: number;
	finishedAt?: number;
	toolCalls?: number;
	usage?: CodeModeUiAgentUsage;
	text?: string;
	error?: string;
	runId?: string;
	phaseId?: string;
	nestingDepth?: number;
}

export interface CodeModeDashboardSnapshot {
	now: number;
	agents: CodeModeUiAgent[];
	jobs: JobSnapshot[];
}

export const activeStatuses = new Set(["queued", "pending", "ready", "claimed", "running", "in_progress", "blocked"]);

export const isActiveStatus = (status: string): boolean => activeStatuses.has(status);

export const orderAgentsByCreation = (agents: CodeModeUiAgent[]): CodeModeUiAgent[] =>
	agents
		.map((agent, index) => ({ agent, index }))
		.sort(
			(left, right) =>
				(left.agent.startedAt ?? Number.MAX_SAFE_INTEGER) - (right.agent.startedAt ?? Number.MAX_SAFE_INTEGER) ||
				left.index - right.index,
		)
		.map(({ agent }) => agent);
