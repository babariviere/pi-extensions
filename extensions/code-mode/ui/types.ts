/**
 * LOCAL REWRITE of upstream `src/ui/types.ts`.
 *
 * Upstream pulled actor/mesh/peer/participant/main-agent types in from
 * subsystems code-mode drops. This module keeps only what the two remaining UI
 * consumers need:
 *   - `ui/widget.ts` (parity file: upstream modulo the mechanical specifier and
 *     naming rewrites) — must stay compilable, so
 *     `CodeModeDashboardSnapshot` keeps `widgetDismissedAt` and an `actors` field
 *     with a locally-declared minimal `CodeModeUiActor`. Code Mode never populates
 *     `actors` (it has no actor subsystem); the field exists purely so the
 *     parity renderer is untouched.
 *   - `ui/snapshot.ts` — builds the reduced snapshot.
 */

import type { CodeModeActivityRun } from "../activity/types.ts";

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

/**
 * Minimal actor shape. Code Mode has no actor subsystem; this exists only so
 * `ui/widget.ts` stays a parity file (structurally unchanged from upstream).
 */
export interface CodeModeUiActor {
	id: string;
	name: string;
	status: string;
	updatedAt: number;
	lastRunId?: string;
	worker?: CodeModeUiAgent;
}

export interface CodeModeDashboardSnapshot {
	now: number;
	widgetDismissedAt?: number;
	runs: CodeModeActivityRun[];
	agents: CodeModeUiAgent[];
	/** Always empty in code-mode. See `CodeModeUiActor`. */
	actors: CodeModeUiActor[];
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
