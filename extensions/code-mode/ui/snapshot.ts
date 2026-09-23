/** Project only active subagents and session-owned jobs into the widget. */
import type { CodeModeState } from "../code-mode-state.ts";
import type { CodeModeAgentRun } from "../providers/agent-run-monitor.ts";
import {
	activeStatuses,
	orderAgentsByCreation,
	type CodeModeDashboardSnapshot,
	type CodeModeUiAgent,
} from "./types.ts";

const MAX_UI_AGENTS = 240;

const agentFromRun = (run: CodeModeAgentRun): CodeModeUiAgent => ({
	id: run.id,
	name: run.name,
	status: run.status,
	startedAt: run.startedAt,
	updatedAt: run.updatedAt,
	...(activeStatuses.has(run.status) ? {} : { finishedAt: run.updatedAt }),
	...(run.currentTool ? { currentTool: run.currentTool } : {}),
	...(run.error ? { error: run.error } : {}),
	...(run.runId ? { runId: run.runId } : {}),
});

const boundedUiAgents = (agents: CodeModeUiAgent[]): CodeModeUiAgent[] => {
	const ordered = orderAgentsByCreation(agents);
	if (ordered.length <= MAX_UI_AGENTS) return ordered;
	return ordered.slice(ordered.length - MAX_UI_AGENTS);
};

export const createDashboardSnapshot = (state: CodeModeState): CodeModeDashboardSnapshot => ({
	now: Date.now(),
	agents: boundedUiAgents(state.agentRuns.list().map(agentFromRun)),
	jobs: state.runningJobs(),
});
