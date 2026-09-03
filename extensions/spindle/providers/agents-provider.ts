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
 * Surface:
 *   agents.list()                    → discovered markdown agent definitions
 *   agents.run({ task, agent?, … })  → one run, blocks for the wait window
 *   agents.runAll({ tasks: [ … ] })  → batch of runs in parallel
 *   agents.start({ task, … })        → launch without blocking, returns a runId
 *   agents.wait({ runId, waitMs? })  → resume waiting on a launched batch
 *   agents.status()                  → live and recent batches
 *   agents.cancel({ runId? })        → tear a batch (or all of them) down
 *
 * Every launch is registered in the run book (`agent-run-book.ts`), which owns
 * waiting, detachment and cancellation. Timing is per *batch*, not per task:
 * `waitMs` bounds how long the caller blocks, `timeoutMs` how long the children
 * may live (clamped to the configured cap).
 *
 * Progress does NOT go out as `progress.ts`'s ANSI block: each row is mirrored
 * into the spindle widget through the run registry, and `renderProgress` is
 * reused as the one-line-per-tick `context.update(...)` body so the spindle
 * renderer shows an in-flight ticker.
 */

import { RunLauncher } from "../agents/backend.ts";
import { CauseBreaker, type CauseVerdict } from "../agents/cause-breaker.ts";
import { discoverAgentsForCwd } from "../agents/discovery.ts";
import { newRunId } from "../agents/paths.ts";
import { buildRunRequests, type NormalizedItem } from "../agents/request.ts";
import { allocateNightWorkspaces, relocateWorkspacePaths, releaseNightWorkspaces } from "../agents/night-workspace.ts";
import type { OnStatus, RunContext, RunRequest, RunResult } from "../agents/run.ts";
import { DEFAULT_SPINDLE_CONFIG, MAX_AGENT_TIMEOUT_MS, MIN_AGENT_TIMEOUT_MS } from "../config.ts";
import type {
	SpindleActionDescriptor,
	SpindleInvocationContext,
	SpindleProvider,
	SpindleProviderListRequest,
} from "../protocol.ts";
import { actionArgNormalizer } from "./arg-normalization.ts";
import { AgentRunBook, type AgentWaitOutcome, type SpindleAgentResult } from "./agent-run-book.ts";
import { RunProgressMonitor, SpindleAgentRunRegistry } from "./agent-run-monitor.ts";

/** Parent session the child runs are attributed to. */
export interface SessionRef {
	sessionId: string | undefined;
	sessionFile: string | undefined;
	cwd: string;
	/**
	 * The session's own project-trust verdict (`context.isProjectTrusted()`),
	 * inherited by every child run so it never raises pi's trust prompt.
	 */
	projectTrusted?: boolean;
}

/** What the caller is told when a wait window expires on a live batch. */
const PENDING_NOTE =
	"still running in the background: resume waiting with agents.wait({ runId }), or stop it with agents.cancel({ runId }). " +
	"Its result is delivered to this session as a follow-up message if nobody claims it.";

export interface SpindleAgentRuntimeConfig {
	timeoutMs: number;
	waitMs: number;
	defaultModel?: string;
	defaultThinking?: string;
}

/** One task in a batch. Timing lives on the batch, not here. */
const taskItemSchema = {
	type: "object",
	properties: {
		agent: { type: "string" },
		task: { type: "string" },
		model: { type: "string" },
		thinking: { type: "string" },
		output: { type: "string" },
		reads: { type: "array", items: { type: "string" } },
		night: { type: "boolean" },
	},
	required: ["task"],
	additionalProperties: false,
};

const waitMsProperty = {
	type: "number",
	minimum: 0,
	description:
		"How long to block before returning a `running` handle. 0 returns immediately. Defaults to the configured wait window.",
};

const timeoutMsProperty = {
	type: "number",
	minimum: 0,
	description:
		"Hard cap on the children's own lifetime; past it they are killed. Clamped to (and defaulting to) the configured timeout.",
};

const timeoutSecProperty = {
	type: "number",
	minimum: 0,
	description: "Same as `timeoutMs`, in seconds. Converted to `timeoutMs` (×1000); `timeoutMs` wins if both are set.",
};

/** The single-run form: one task plus the batch's timing. */
const runItemSchema = {
	...taskItemSchema,
	properties: {
		...taskItemSchema.properties,
		waitMs: waitMsProperty,
		timeoutMs: timeoutMsProperty,
		timeoutSec: timeoutSecProperty,
	},
};

/**
 * `start` accepts either the single-task form or `{ tasks }`, so neither `task`
 * nor `tasks` can be required by the schema; `tasksOf` rejects a call that
 * carries neither.
 */
const startSchema = {
	type: "object",
	properties: {
		...taskItemSchema.properties,
		tasks: { type: "array", items: taskItemSchema },
		timeoutMs: timeoutMsProperty,
		timeoutSec: timeoutSecProperty,
	},
	additionalProperties: false,
};

const descriptors: SpindleActionDescriptor[] = [
	{
		name: "list",
		description: "List custom agent definitions discovered under ~/.pi/agent/agents and <cwd>/.pi/agents",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	},
	{
		name: "run",
		description:
			"Run a subagent on a task and wait for its result. `agent` is optional: omit it to run a generic subagent that inherits the parent model, tools, skills and project context. Optional per-run model/thinking overrides, an `output` path for the submitted result, `reads` for read-first context files, and `night: true` to inherit the night-mode contract of an unattended overnight run. Blocks for at most `waitMs`; if the run is still going the result carries `state: 'running'` and a `runId` to resume with agents.wait.",
		inputSchema: runItemSchema,
	},
	{
		name: "runAll",
		description:
			"Run several subagents in parallel and wait for all of them. Each item's `agent` is optional. `waitMs` and `timeoutMs` apply to the whole batch. Same bounded wait as agents.run: results may come back with `state: 'running'` and a shared `runId`.",
		inputSchema: {
			type: "object",
			properties: {
				tasks: { type: "array", items: taskItemSchema },
				waitMs: waitMsProperty,
				timeoutMs: timeoutMsProperty,
				timeoutSec: timeoutSecProperty,
			},
			required: ["tasks"],
			additionalProperties: false,
		},
	},
	{
		name: "start",
		description:
			"Launch one subagent (or a batch, with `tasks`) without blocking. Returns a `runId` to poll with agents.wait. The run is not tied to this turn: it survives until it finishes, is cancelled, or the session ends.",
		inputSchema: startSchema,
	},
	{
		name: "wait",
		description:
			"Resume waiting on a launched batch for at most `waitMs`. Returns `{ state: 'running' }` when the window expires again (not an error), or the settled results.",
		inputSchema: {
			type: "object",
			properties: { runId: { type: "string" }, waitMs: waitMsProperty },
			required: ["runId"],
			additionalProperties: false,
		},
	},
	{
		name: "status",
		description:
			"List live and recently finished subagent batches with their runId, state and elapsed time. Outputs are not included: read them with agents.wait({ runId }).",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	},
	{
		name: "cancel",
		description:
			"Cancel a batch by `runId`, or every live batch when omitted. Headless children are torn down process-group wide; a herdr batch has its pane tab closed.",
		inputSchema: {
			type: "object",
			properties: { runId: { type: "string" } },
			additionalProperties: false,
		},
	},
];

const normalizeAgentArgs = actionArgNormalizer(() => descriptors);

const stringOrUndefined = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim() ? value : undefined;

const stringArrayOrUndefined = (value: unknown): string[] | undefined =>
	Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : undefined;

/** Clamp a caller-supplied duration, falling back when it is absent or unusable. */
const boundedMs = (value: unknown, fallback: number, minimum: number, maximum: number): number => {
	if (typeof value !== "number" || !Number.isFinite(value)) return Math.min(fallback, maximum);
	return Math.max(minimum, Math.min(Math.floor(value), maximum));
};

/**
 * Resolve a caller-supplied `timeoutMs`/`timeoutSec` pair to milliseconds.
 * `timeoutMs` wins if both are set; `timeoutSec` is converted (×1000)
 * otherwise. Neither present resolves to `undefined` so `boundedMs` falls
 * back to its default.
 */
const resolveTimeoutMs = (args: Record<string, unknown>): unknown => {
	if (typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs)) return args.timeoutMs;
	if (typeof args.timeoutSec === "number" && Number.isFinite(args.timeoutSec)) return args.timeoutSec * 1000;
	return args.timeoutMs;
};

const normalizedItem = (value: unknown): NormalizedItem => {
	const record =
		typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	const model = stringOrUndefined(record.model);
	const thinking = stringOrUndefined(record.thinking);
	const output = stringOrUndefined(record.output);
	const reads = stringArrayOrUndefined(record.reads);
	const night = record.night === true;
	return {
		...(record.agent === undefined ? {} : { agent: String(record.agent) }),
		task: String(record.task ?? ""),
		...(model ? { model } : {}),
		...(thinking ? { thinking } : {}),
		...(output ? { output } : {}),
		...(reads ? { reads } : {}),
		...(night ? { night } : {}),
	};
};

const agentResult = (result: RunResult, runId: string): SpindleAgentResult => ({
	agent: result.agent,
	ok: result.ok,
	output: result.output,
	state: result.ok ? "done" : "failed",
	runId,
	...(result.outputPath ? { outputPath: result.outputPath } : {}),
	...(result.backend === "headless" && result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
	...(result.backend === "herdr" && result.paneId ? { paneId: result.paneId } : {}),
	...(result.error ? { error: result.error } : {}),
	...(result.failure ? { failure: result.failure } : {}),
});

/**
 * The result of a batch that was never launched, because the last attempts all
 * failed the same way. It is a `launch` failure like any other, so the
 * coordinator treats it as a runner fault rather than re-planning the task.
 */
const refusedResult = (request: RunRequest, verdict: CauseVerdict, onStatus: OnStatus): RunResult => {
	onStatus(request.index, { state: "failed" });
	const error =
		`refusing to launch: the last ${verdict.count} launches failed with the same cause (${verdict.error}). ` +
		"The runner is down, not this task; it will be retried once the breaker's window elapses.";
	return {
		agent: request.agent.config.name,
		scope: request.agent.scope,
		ok: false,
		output: `(${error})`,
		backend: "headless",
		error,
		failure: "launch",
	};
};

/** The placeholder result a still-running run reports. */
const pendingResult = (agent: string, runId: string, elapsedMs: number): SpindleAgentResult => ({
	agent,
	ok: false,
	state: "running",
	runId,
	output: `(${agent} has been running for ${Math.round(elapsedMs / 1000)}s and ${PENDING_NOTE})`,
});

/** A launched batch, before anyone waits on it. */
interface LaunchedBatch {
	runId: string;
	agents: string[];
}

/**
 * The tasks a call carries: `{ tasks }` when present, else the single-task form.
 * Rejects a call with no usable task rather than launching a child with an empty
 * prompt (the schema cannot require `task` for the actions that accept both
 * forms).
 */
const tasksOf = (args: Record<string, unknown>, action: string): NormalizedItem[] => {
	const raw = Array.isArray(args.tasks) ? args.tasks : [args];
	const items = raw.map(normalizedItem).filter((item) => item.task.trim().length > 0);
	if (items.length === 0) throw new Error(`${action} requires at least one non-empty task`);
	return items;
};

export class SpindleAgentsProvider implements SpindleProvider {
	readonly name = "agents";
	readonly description =
		"Custom markdown agents discovered on disk, run as child Pi sessions (headless, or live herdr panes)";

	constructor(
		readonly session: () => SessionRef,
		readonly registry: SpindleAgentRunRegistry,
		readonly runtimeConfig: () => SpindleAgentRuntimeConfig,
		/** Live batches, so a run can outlive the program that started it. */
		readonly runs: AgentRunBook = new AgentRunBook(),
		/** Adapter selection and herdr drift containment (see agents/backend.ts). */
		readonly launcher: RunLauncher = new RunLauncher(),
		/** Refuses to relaunch into a fault that already proved itself. */
		readonly breaker: CauseBreaker = new CauseBreaker(),
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

	/**
	 * Canonicalize near-miss argument spellings (prompt -> task, id -> runId,
	 * "5000" -> 5000) from the declared schemas before validation rejects them.
	 */
	prepareArguments(actionName: string, args: Record<string, unknown>): Record<string, unknown> {
		return normalizeAgentArgs(actionName, args);
	}

	async invoke(
		actionName: string,
		args: Record<string, unknown>,
		context: SpindleInvocationContext,
	): Promise<unknown> {
		const ref = this.session();
		const runtime = this.runtimeConfig();
		const waitMs = (): number => boundedMs(args.waitMs, runtime.waitMs, 0, MAX_AGENT_TIMEOUT_MS);
		switch (actionName) {
			case "list":
				return discoverAgentsForCwd(ref.cwd).map((agent) => ({
					name: agent.config.name,
					scope: agent.scope,
					...(agent.config.description ? { description: agent.config.description } : {}),
				}));
			case "run": {
				const batch = await this.#launch(tasksOf(args, "agents.run"), args, context, { attach: true });
				const outcome = await this.runs.wait(batch.runId, waitMs());
				const first = this.#resultsOf(batch, outcome)[0];
				if (!first) throw new Error("agents.run produced no result");
				return first;
			}
			case "runAll": {
				if (!Array.isArray(args.tasks) || args.tasks.length === 0) {
					throw new Error("agents.runAll requires a non-empty tasks array");
				}
				const batch = await this.#launch(tasksOf(args, "agents.runAll"), args, context, { attach: true });
				const outcome = await this.runs.wait(batch.runId, waitMs());
				return this.#resultsOf(batch, outcome);
			}
			case "start": {
				// Detached on purpose: no link to this turn's abort signal, so the run
				// survives the program that launched it.
				const batch = await this.#launch(tasksOf(args, "agents.start"), args, context, { attach: false });
				return { runId: batch.runId, agents: batch.agents, state: "running" as const };
			}
			case "wait": {
				const runId = stringOrUndefined(args.runId);
				if (!runId) throw new Error("agents.wait requires a runId");
				const outcome = await this.runs.wait(runId, waitMs());
				return {
					runId,
					state: outcome.state,
					elapsedMs: outcome.snapshot.elapsedMs,
					agents: outcome.snapshot.agents,
					results:
						outcome.results ??
						outcome.snapshot.agents.map((agent) => pendingResult(agent, runId, outcome.snapshot.elapsedMs)),
				};
			}
			case "status":
				return this.runs.list();
			case "cancel":
				return { cancelled: this.runs.cancel(stringOrUndefined(args.runId)) };
			default:
				throw new Error(`Unknown agents action: agents.${actionName}`);
		}
	}

	/**
	 * Teach the breaker what this batch proved. Only launch-class failures count:
	 * a child that ran and came back empty is a task problem, and relaunching is
	 * exactly the right response to it.
	 */
	#recordCauses(results: RunResult[]): void {
		for (const result of results) {
			if (result.failure === "launch") this.breaker.record(result.error);
			else this.breaker.clear();
		}
	}

	/** Settled results, or one pending placeholder per agent still running. */
	#resultsOf(batch: LaunchedBatch, outcome: AgentWaitOutcome): SpindleAgentResult[] {
		if (outcome.results) return outcome.results;
		return batch.agents.map((agent) => pendingResult(agent, batch.runId, outcome.snapshot.elapsedMs));
	}

	/**
	 * Resolve raw items to run requests: discover the agents (always at least the
	 * built-in personaless one), apply the runtime model/thinking defaults, then
	 * build and validate the requests. Pure of UI and spawning.
	 */
	#resolveRequests(items: NormalizedItem[], ref: SessionRef, runtimeConfig: SpindleAgentRuntimeConfig): RunRequest[] {
		const discovered = discoverAgentsForCwd(ref.cwd);
		const withDefaults = items.map((item) => ({
			...item,
			...((item.model ?? runtimeConfig.defaultModel) ? { model: item.model ?? runtimeConfig.defaultModel } : {}),
			...((item.thinking ?? runtimeConfig.defaultThinking)
				? { thinking: item.thinking ?? runtimeConfig.defaultThinking }
				: {}),
		}));
		const built = buildRunRequests({ tasks: withDefaults }, discovered, ref.cwd);
		if ("error" in built) throw new Error(built.error);
		return built.requests;
	}

	/**
	 * Spawn a batch and register it in the run book, without waiting for it.
	 *
	 * The batch owns its abort controller so it can outlive this invocation. An
	 * attached launch routes the invocation's abort through `runs.cancel`, which
	 * kills the children *and* marks the batch cancelled, so a caller that was
	 * abandoned mid-wait cannot leave a settled result addressed to nobody. The
	 * link is dropped once the batch detaches (its wait window expired), which is
	 * what keeps a background run alive past the turn that started it.
	 */
	async #launch(
		items: NormalizedItem[],
		args: Record<string, unknown>,
		context: SpindleInvocationContext,
		options: { attach: boolean },
	): Promise<LaunchedBatch> {
		const ref = this.session();
		const runtimeConfig = this.runtimeConfig();
		const requests = this.#resolveRequests(items, ref, runtimeConfig);

		const runId = newRunId();

		// Host-side placement: a child of a night run gets its own jj workspace so
		// two subagents never share a working copy. Nothing here comes from the
		// model; `cwd` is not part of the tool schema.
		const workspaces = await allocateNightWorkspaces(requests, runId, ref.cwd);

		// One selection per process (the herdr dialect probe runs at most once):
		// a drifted herdr CLI degrades to headless instead of failing the batch.
		const selection = await this.launcher.selection();
		const note = selection.degradedReason
			? `herdr degraded (${selection.degradedReason}); running headless`
			: undefined;

		const monitor = new RunProgressMonitor(
			{ registry: this.registry, context, runId, ...(note ? { note } : {}) },
			requests,
		);
		monitor.start();

		const controller = new AbortController();
		const parentSignal = options.attach ? context.signal : undefined;
		const onParentAbort = (): void => {
			this.runs.cancel(runId);
		};
		const unlink = (): void => parentSignal?.removeEventListener("abort", onParentAbort);

		const configuredTimeoutMs = runtimeConfig.timeoutMs || DEFAULT_SPINDLE_CONFIG.agents.timeoutMs;
		const runContext: RunContext = {
			sessionId: ref.sessionId,
			sessionFile: ref.sessionFile,
			runId,
			cwd: ref.cwd,
			// Inherited, not re-derived: a child in a fresh working copy would
			// otherwise stop on pi's project-trust prompt with no tty to answer.
			projectTrusted: ref.projectTrusted === true,
			// The configured timeout is a cap, not a default a caller can raise.
			timeoutMs: boundedMs(resolveTimeoutMs(args), configuredTimeoutMs, MIN_AGENT_TIMEOUT_MS, configuredTimeoutMs),
			signal: controller.signal,
			onStatus: monitor.onStatus,
		};

		const promise = (async (): Promise<SpindleAgentResult[]> => {
			try {
				// A cause that has already failed the last N launches is not paid for
				// again: the batch is refused on the spot with the recorded reason, so a
				// broken runner costs one timeout instead of a whole night of them. The
				// breaker is half-open, so a probe goes through once its window elapses.
				const refused = this.breaker.verdict();
				const results = refused
					? requests.map((request) => refusedResult(request, refused, monitor.onStatus))
					: await this.launcher.run(requests, runContext);
				this.#recordCauses(results);
				// A night child names paths inside its workspace, which the release
				// below deletes after copying its files out. Rewrite those paths to
				// the surviving copies so the coordinator never reports a dead path.
				return results.map((result) => agentResult(relocateWorkspacePaths(result, workspaces), runId));
			} finally {
				unlink();
				monitor.stop();
				await releaseNightWorkspaces(workspaces);
			}
		})();

		const agents = requests.map((request) => request.agent.config.name);
		this.runs.register({
			runId,
			agents,
			promise,
			cancel: () => controller.abort(),
			// Detaching drops the turn link and the ticker; the widget rows keep
			// updating from the backend's status callback.
			onDetach: () => {
				unlink();
				monitor.stop();
			},
		});

		// The batch is registered before the link is armed, so the cancel path
		// always finds it. No await separates the two.
		if (parentSignal?.aborted) this.runs.cancel(runId);
		else parentSignal?.addEventListener("abort", onParentAbort, { once: true });

		return { runId, agents };
	}
}
