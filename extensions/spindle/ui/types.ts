/**
 * LOCAL REWRITE of upstream `src/ui/types.ts`.
 *
 * Upstream pulled actor/mesh/peer/participant/main-agent types in from
 * subsystems spindle drops. This module keeps only what the two remaining UI
 * consumers need:
 *   - `ui/widget.ts` (parity file: upstream modulo the mechanical specifier and
 *     naming rewrites) — must stay compilable, so
 *     `SpindleDashboardSnapshot` keeps `widgetDismissedAt` and an `actors` field
 *     with a locally-declared minimal `SpindleUiActor`. Spindle never populates
 *     `actors` (it has no actor subsystem); the field exists purely so the
 *     parity renderer is untouched.
 *   - `ui/snapshot.ts` — builds the reduced snapshot.
 */

import type { SpindleActivityRun } from "../activity/types.ts";

/** Token counters read by `ui/widget.ts`; local stand-in for upstream `AgentUsage`. */
export interface SpindleUiAgentUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number;
}

export interface SpindleUiAgent {
  id: string;
  name: string;
  status: string;
  currentTool?: string;
  startedAt?: number;
  updatedAt?: number;
  finishedAt?: number;
  toolCalls?: number;
  usage?: SpindleUiAgentUsage;
  text?: string;
  error?: string;
  runId?: string;
  phaseId?: string;
  nestingDepth?: number;
}

/**
 * Minimal actor shape. Spindle has no actor subsystem; this exists only so
 * `ui/widget.ts` stays a parity file (structurally unchanged from upstream).
 */
export interface SpindleUiActor {
  id: string;
  name: string;
  status: string;
  updatedAt: number;
  lastRunId?: string;
  worker?: SpindleUiAgent;
}

export interface SpindleDashboardSnapshot {
  now: number;
  widgetDismissedAt?: number;
  runs: SpindleActivityRun[];
  agents: SpindleUiAgent[];
  /** Always empty in spindle. See `SpindleUiActor`. */
  actors: SpindleUiActor[];
}

export const activeStatuses = new Set([
  "queued",
  "pending",
  "ready",
  "claimed",
  "running",
  "in_progress",
  "blocked",
]);

export const isActiveStatus = (status: string): boolean => activeStatuses.has(status);

export const orderAgentsByCreation = (agents: SpindleUiAgent[]): SpindleUiAgent[] =>
  agents
    .map((agent, index) => ({ agent, index }))
    .sort(
      (left, right) =>
        (left.agent.startedAt ?? Number.MAX_SAFE_INTEGER) -
          (right.agent.startedAt ?? Number.MAX_SAFE_INTEGER) ||
        left.index - right.index,
    )
    .map(({ agent }) => agent);
