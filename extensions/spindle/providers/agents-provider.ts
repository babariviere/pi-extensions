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
 *   agents.run({ task, agent?, … })  → one run, blocks until it finishes
 *   agents.runAll({ tasks: [ … ] })  → batch of runs in parallel
 *
 * Progress does NOT go out as `progress.ts`'s ANSI block: each row is mirrored
 * into the spindle widget through the run registry, and `renderProgress` is
 * reused as the one-line-per-tick `context.update(...)` body so the spindle
 * renderer shows an in-flight ticker.
 */

import { selectBackend } from "../agents/backend.ts";
import { discoverAgentsForCwd } from "../agents/discovery.ts";
import { newRunId } from "../agents/paths.ts";
import { buildRunRequests, type NormalizedItem } from "../agents/request.ts";
import type { RunContext, RunRequest, RunResult } from "../agents/run.ts";
import type {
  SpindleActionDescriptor,
  SpindleInvocationContext,
  SpindleProvider,
  SpindleProviderListRequest,
} from "../protocol.ts";
import { RunProgressMonitor, SpindleAgentRunRegistry } from "./agent-run-monitor.ts";

/** Parent session the child runs are attributed to. */
export interface SessionRef {
  sessionId: string | undefined;
  sessionFile: string | undefined;
  cwd: string;
}

export const DEFAULT_RUN_TIMEOUT_MS = 30 * 60 * 1000;

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
  required: ["task"],
  additionalProperties: false,
};

const descriptors: SpindleActionDescriptor[] = [
  {
    name: "list",
    description:
      "List custom agent definitions discovered under ~/.pi/agent/agents and <cwd>/.pi/agents",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "run",
    description:
      "Run a subagent on a task and wait for its result. `agent` is optional: omit it to run a generic subagent that inherits the parent model, tools, skills and project context. Optional per-run model/thinking overrides, an `output` path for the submitted result, and `reads` for read-first context files.",
    inputSchema: taskItemSchema,
  },
  {
    name: "runAll",
    description:
      "Run several subagents in parallel and wait for all of them to finish. Each item's `agent` is optional.",
    inputSchema: {
      type: "object",
      properties: { tasks: { type: "array", items: taskItemSchema } },
      required: ["tasks"],
      additionalProperties: false,
    },
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
    ...(record.agent === undefined ? {} : { agent: String(record.agent) }),
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
  ...(result.backend === "headless" && result.exitCode !== undefined
    ? { exitCode: result.exitCode }
    : {}),
  ...(result.backend === "herdr" && result.paneId ? { paneId: result.paneId } : {}),
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

  /**
   * Resolve raw items to run requests: discover the agents (always at least the
   * built-in personaless one), apply the runtime model/thinking defaults, then
   * build and validate the requests. Pure of UI and spawning.
   */
  #resolveRequests(
    items: NormalizedItem[],
    ref: SessionRef,
    runtimeConfig: SpindleAgentRuntimeConfig,
  ): RunRequest[] {
    const discovered = discoverAgentsForCwd(ref.cwd);
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
    return built.requests;
  }

  async #run(
    items: NormalizedItem[],
    context: SpindleInvocationContext,
  ): Promise<SpindleAgentResult[]> {
    const ref = this.session();
    const runtimeConfig = this.runtimeConfig();
    const requests = this.#resolveRequests(items, ref, runtimeConfig);

    const runId = newRunId();
    const monitor = new RunProgressMonitor({ registry: this.registry, context, runId }, requests);
    monitor.start();

    const runContext: RunContext = {
      sessionId: ref.sessionId,
      sessionFile: ref.sessionFile,
      runId,
      cwd: ref.cwd,
      timeoutMs: runtimeConfig.timeoutMs || DEFAULT_RUN_TIMEOUT_MS,
      ...(context.signal ? { signal: context.signal } : {}),
      onStatus: monitor.onStatus,
    };

    try {
      const results = await selectBackend()(requests, runContext);
      return results.map(agentResult);
    } finally {
      monitor.stop();
    }
  }
}
