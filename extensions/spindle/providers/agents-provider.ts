/**
 * `agents.*` namespace, backed by the absorbed subagents code in
 * `../agents/`.
 *
 * NOTE: this is a NEW spindle file. Upstream has a same-named
 * `src/providers/agents-provider.ts` that fronts its own RLM/handoff agent
 * runtime; that file is deliberately NOT vendored. The local `../agents/`
 * directory is the absorbed `extensions/subagents` code and is unrelated to
 * upstream's dropped `src/agents/`.
 *
 * Surface (exactly three actions):
 *   agents.list()                    → discovered markdown agent definitions
 *   agents.run({ agent, task, … })   → one run, blocks until it finishes
 *   agents.runAll({ tasks: [ … ] })  → batch of runs in parallel
 *
 * Progress does NOT go out as `progress.ts`'s ANSI block: each row is mirrored
 * into the spindle widget through the run registry, and `renderProgress` is
 * reused as the one-line-per-tick `context.update(...)` body so the spindle
 * renderer shows an in-flight ticker.
 */

import { selectBackend } from "../agents/backend.ts";
import { discoverAgentsForCwd, getProjectAgentsDir, getUserAgentsDir } from "../agents/discovery.ts";
import { newRunId } from "../agents/paths.ts";
import { type AgentProgress, applyStatus, renderProgress } from "../agents/progress.ts";
import { buildRunRequests, type NormalizedItem } from "../agents/request.ts";
import type { RunContext, RunResult, RunState, RunStatusUpdate } from "../agents/run.ts";
import type {
  SpindleActionDescriptor,
  SpindleInvocationContext,
  SpindleProvider,
  SpindleProviderListRequest,
} from "../protocol.ts";

/** Parent session the child runs are attributed to. */
export interface SessionRef {
  sessionId: string | undefined;
  sessionFile: string | undefined;
  cwd: string;
}

export const DEFAULT_RUN_TIMEOUT_MS = 30 * 60 * 1000;
export const PROGRESS_TICK_MS = 100;

/** Widget-facing view of one in-flight or finished subagent run. */
export interface SpindleAgentRun {
  id: string;
  name: string;
  status: string;
  startedAt: number;
  updatedAt: number;
  currentTool?: string;
  error?: string;
  runId?: string;
}

const STATUS_FROM_STATE: Record<RunState, string> = {
  spawning: "queued",
  running: "running",
  done: "completed",
  failed: "failed",
};

/**
 * Live registry of subagent runs, read by `ui/snapshot.ts` so the single
 * `aboveEditor` widget renders one spinner row per run through
 * `ui/widget.ts`'s existing `agentLines()`.
 */
export class SpindleAgentRunRegistry {
  readonly #runs = new Map<string, SpindleAgentRun>();
  readonly #listeners = new Set<() => void>();

  list(): SpindleAgentRun[] {
    return [...this.#runs.values()];
  }

  upsert(run: SpindleAgentRun): void {
    this.#runs.set(run.id, run);
    this.#notify();
  }

  reset(): void {
    this.#runs.clear();
    this.#notify();
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #notify(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        // Widget refresh must never break a run.
      }
    }
  }
}

export interface SpindleAgentRuntimeConfig {
  timeoutMs: number;
  defaultModel?: string;
  defaultThinking?: string;
}

const taskItemSchema = {
  type: "object",
  properties: {
    agent: { type: "string" },
    task: { type: "string" },
    model: { type: "string" },
    thinking: { type: "string" },
    output: { type: "string" },
    reads: { type: "array", items: { type: "string" } },
  },
  required: ["agent", "task"],
  additionalProperties: false,
};

const descriptors: SpindleActionDescriptor[] = [
  {
    name: "list",
    description:
      "List custom agent definitions discovered under ~/.pi/agent/agents and <cwd>/.pi/agents",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    risk: "read",
  },
  {
    name: "run",
    description:
      "Run one discovered agent on a task and wait for its result. Optional per-run model/thinking overrides, an `output` path for the agent's submitted result, and `reads` for read-first context files.",
    inputSchema: taskItemSchema,
    risk: "agent",
  },
  {
    name: "runAll",
    description:
      "Run several discovered agents in parallel and wait for all of them to finish.",
    inputSchema: {
      type: "object",
      properties: { tasks: { type: "array", items: taskItemSchema } },
      required: ["tasks"],
      additionalProperties: false,
    },
    risk: "agent",
  },
];

const stringOrUndefined = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

const stringArrayOrUndefined = (value: unknown): string[] | undefined =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : undefined;

const normalizedItem = (value: unknown): NormalizedItem => {
  const record =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const model = stringOrUndefined(record.model);
  const thinking = stringOrUndefined(record.thinking);
  const output = stringOrUndefined(record.output);
  const reads = stringArrayOrUndefined(record.reads);
  return {
    agent: String(record.agent ?? ""),
    task: String(record.task ?? ""),
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    ...(output ? { output } : {}),
    ...(reads ? { reads } : {}),
  };
};

/** Structured value returned to the sandbox for a single run. */
export interface SpindleAgentResult {
  agent: string;
  ok: boolean;
  output: string;
  outputPath: string;
  exitCode?: number;
  paneId?: string;
  error?: string;
}

const agentResult = (result: RunResult): SpindleAgentResult => ({
  agent: result.agent,
  ok: result.ok,
  output: result.output,
  outputPath: result.outputPath,
  ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
  ...(result.paneId ? { paneId: result.paneId } : {}),
  ...(result.error ? { error: result.error } : {}),
});

export class SpindleAgentsProvider implements SpindleProvider {
  readonly name = "agents";
  readonly description =
    "Custom markdown agents discovered on disk, run as child Pi sessions (headless, or live herdr panes)";

  constructor(
    readonly session: () => SessionRef,
    readonly registry: SpindleAgentRunRegistry,
    readonly runtimeConfig: () => SpindleAgentRuntimeConfig,
  ) {}

  async list(
    _request: SpindleProviderListRequest,
    _context: SpindleInvocationContext,
  ): Promise<SpindleActionDescriptor[]> {
    return descriptors;
  }

  async describe(
    actionName: string,
    _context: SpindleInvocationContext,
  ): Promise<SpindleActionDescriptor | undefined> {
    return descriptors.find((descriptor) => descriptor.name === actionName);
  }

  async invoke(
    actionName: string,
    args: Record<string, unknown>,
    context: SpindleInvocationContext,
  ): Promise<unknown> {
    const ref = this.session();
    switch (actionName) {
      case "list":
        return discoverAgentsForCwd(ref.cwd).map((agent) => ({
          name: agent.config.name,
          scope: agent.scope,
          ...(agent.config.description ? { description: agent.config.description } : {}),
        }));
      case "run": {
        const results = await this.#run([normalizedItem(args)], context);
        const first = results[0];
        if (!first) throw new Error("agents.run produced no result");
        return first;
      }
      case "runAll": {
        const tasks = Array.isArray(args.tasks) ? args.tasks : [];
        if (tasks.length === 0) throw new Error("agents.runAll requires a non-empty tasks array");
        return this.#run(tasks.map(normalizedItem), context);
      }
      default:
        throw new Error(`Unknown agents action: agents.${actionName}`);
    }
  }

  async #run(
    items: NormalizedItem[],
    context: SpindleInvocationContext,
  ): Promise<SpindleAgentResult[]> {
    const ref = this.session();
    const discovered = discoverAgentsForCwd(ref.cwd);
    if (discovered.length === 0) {
      throw new Error(
        `No custom agents were found. Searched ${getUserAgentsDir()} and ${getProjectAgentsDir(ref.cwd)}.`,
      );
    }
    const runtimeConfig = this.runtimeConfig();
    const withDefaults = items.map((item) => ({
      ...item,
      ...(item.model ?? runtimeConfig.defaultModel
        ? { model: item.model ?? runtimeConfig.defaultModel }
        : {}),
      ...(item.thinking ?? runtimeConfig.defaultThinking
        ? { thinking: item.thinking ?? runtimeConfig.defaultThinking }
        : {}),
    }));
    const built = buildRunRequests({ tasks: withDefaults }, discovered, ref.cwd);
    if ("error" in built) throw new Error(built.error);
    const resolved = built.requests;

    const runId = newRunId();
    const startedAt = Date.now();
    const progress: AgentProgress[] = resolved.map((request) => ({
      name: request.agent.config.name,
      scope: request.agent.scope,
      state: "spawning" as RunState,
      startedAt,
    }));
    const ids = resolved.map((request) => `${runId}-${request.index}`);
    for (const [index, row] of progress.entries()) {
      context.activity?.({
        type: "entity",
        id: ids[index] ?? `${runId}-${index}`,
        kind: "agent",
        name: row.name,
      });
    }

    let live = true;
    let frame = 0;
    const publish = (): void => {
      const now = Date.now();
      for (const [index, row] of progress.entries()) {
        this.registry.upsert({
          id: ids[index] ?? `${runId}-${index}`,
          name: row.name,
          status: STATUS_FROM_STATE[row.state],
          startedAt: row.startedAt,
          updatedAt: row.endedAt ?? now,
          // The activity run id is the outer spindle_exec tool call id, so the
          // widget can associate these rows with the running program.
          runId: context.parentToolCallId,
          ...(row.state === "spawning" || row.state === "running"
            ? { currentTool: row.state }
            : {}),
        });
      }
      if (!live) return;
      // renderProgress stays the tested renderer; one line per tick keeps the
      // spindle progress line compact instead of dumping an ANSI block.
      const message = renderProgress(progress, now, { frame }).split("\n").join(" · ");
      context.update(message);
      context.activity?.({ type: "progress", message });
    };
    publish();
    const ticker = setInterval(() => {
      frame++;
      publish();
    }, PROGRESS_TICK_MS);
    ticker.unref?.();

    const runContext: RunContext = {
      sessionId: ref.sessionId,
      sessionFile: ref.sessionFile,
      runId,
      cwd: ref.cwd,
      timeoutMs: runtimeConfig.timeoutMs || DEFAULT_RUN_TIMEOUT_MS,
      ...(context.signal ? { signal: context.signal } : {}),
      onStatus: (index: number, update: RunStatusUpdate) => {
        applyStatus(progress, index, update);
        publish();
      },
    };

    let results: RunResult[];
    try {
      results = await selectBackend()(resolved, runContext);
    } finally {
      live = false;
      clearInterval(ticker);
    }
    publish();
    return results.map(agentResult);
  }
}
