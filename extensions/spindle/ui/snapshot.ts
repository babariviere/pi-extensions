/**
 * LOCAL REWRITE of upstream `src/ui/snapshot.ts`.
 *
 * Upstream built a full dashboard snapshot from the mesh store, the participant
 * directory and spindle's own agent manager. Spindle has none of those: the
 * snapshot is the activity runs plus the subagent run registry, mapped onto the
 * `SpindleUiAgent` shape `ui/widget.ts` already renders.
 */

import type { SpindleActivityRun } from "../activity/types.ts";
import type { SpindleState } from "../spindle-state.ts";
import type { SpindleAgentRun } from "../providers/agents-provider.ts";
import {
  activeStatuses,
  orderAgentsByCreation,
  type SpindleDashboardSnapshot,
  type SpindleUiAgent,
} from "./types.ts";

const MAX_UI_AGENTS = 240;

const agentFromRun = (run: SpindleAgentRun): SpindleUiAgent => ({
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

const boundedUiAgents = (agents: SpindleUiAgent[]): SpindleUiAgent[] => {
  const ordered = orderAgentsByCreation(agents);
  if (ordered.length <= MAX_UI_AGENTS) return ordered;
  return ordered.slice(ordered.length - MAX_UI_AGENTS);
};

export const createDashboardSnapshot = (
  state: SpindleState,
  _context?: unknown,
  activityRuns?: SpindleActivityRun[],
): SpindleDashboardSnapshot => {
  const runs = activityRuns ?? state.activity.runs();
  const agents = boundedUiAgents(state.agentRuns.list().map(agentFromRun));
  const activeRunIds = new Set(
    agents
      .filter((agent) => agent.runId && activeStatuses.has(agent.status))
      .map((agent) => agent.runId as string),
  );
  const orderedRuns = runs
    .map((run, index) => ({ run, index }))
    .sort((left, right) => {
      const leftActive = activeRunIds.has(left.run.id) ? 1 : 0;
      const rightActive = activeRunIds.has(right.run.id) ? 1 : 0;
      return rightActive - leftActive || left.index - right.index;
    })
    .map(({ run }) => run);

  return {
    now: Date.now(),
    widgetDismissedAt: state.widgetDismissedAt,
    runs: orderedRuns,
    agents,
    actors: [],
  };
};
