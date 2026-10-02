/**
 * Native agents actions backed by child Pi sessions.
 * The run book owns bounded waiting, detachment, cancellation and unclaimed
 * completion delivery. Progress is projected to a compact optional widget
 * and tool updates, with no independent execution runtime.
 */

import { RunLauncher } from "./backend.ts";
import { CauseBreaker, type CauseVerdict } from "./cause-breaker.ts";
import { recordNightCapability } from "./night-journal.ts";
import { BUILTIN_AGENT_NAME, discoverAgentsForCwd } from "./discovery.ts";
import { subagentModelPriceError } from "./model-policy.ts";
import { extractThinkingSuffix, qualifyModel } from "./pi-args.ts";
import { newRunId } from "./paths.ts";
import { buildRunRequests, type NormalizedItem, validateOverrides } from "./request.ts";
import { allocateNightWorkspaces, relocateWorkspacePaths, releaseNightWorkspaces } from "./night-workspace.ts";
import type { OnStatus, RunContext, RunRequest, RunResult } from "./run.ts";
import { DEFAULT_SUBAGENTS_CONFIG, MAX_AGENT_TIMEOUT_MS } from "./config.ts";
import type { ActionDescriptor, ActionContext, ActionProvider, ActionListRequest } from "../shared/action-tools.ts";
import { actionArgNormalizer } from "./arg-normalization.ts";
import { AgentRunBook, type AgentWaitOutcome, type AgentResult } from "./agent-run-book.ts";
import type { AgentRuns } from "./agent-runs.ts";
import { RunProgressMonitor, AgentRunRegistry } from "./agent-run-monitor.ts";
import { isNightRunParticipant, type ActiveNightRun, readActiveNightRun } from "../night-mode/night-run.ts";

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
	"still running in the background: resume waiting with tools.agents_wait({ runId }), or stop it with tools.agents_cancel({ runId }). " +
	"Its result is delivered to this session as a follow-up message if nobody claims it.";

export interface AgentRuntimeConfig {
	timeoutMs: number;
	waitMs: number;
	defaultModel?: string;
	/** Live caller provider. Child models cannot cross this boundary. */
	parentProvider?: string;
	defaultThinking?: string;
	/** Available parent models and their configured prices. */
	models?: readonly import("@earendil-works/pi-ai").Model<any>[];
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
		nightTodoId: { type: "string", description: "Approved night ledger id, required while a night run is active" },
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

/**
 * `wait`-only alias. It means the same thing as `waitMs`, and `waitMs` wins if
 * both are set.
 */
const waitTimeoutMsAliasProperty = {
	type: "number",
	minimum: 0,
	description: "Alias for `waitMs`. It bounds how long this call blocks; `waitMs` wins if both are set.",
};

/** The single-run form: one task plus the batch's timing. */
const runItemSchema = {
	...taskItemSchema,
	properties: {
		...taskItemSchema.properties,
		waitMs: waitMsProperty,
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
	},
	additionalProperties: false,
};

const modelCatalogEntrySchema = {
	type: "object",
	properties: {
		id: { type: "string" },
		name: { type: "string" },
		provider: { type: "string" },
		reasoning: { type: "boolean" },
		input: { type: "array", items: { type: "string" } },
		contextWindow: { type: "number" },
		maxTokens: { type: "number" },
	},
	required: ["id", "name", "provider"],
	additionalProperties: false,
};

const agentResultProperties = {
	agent: { type: "string" },
	ok: { type: "boolean" },
	output: { type: "string" },
	state: { enum: ["done", "failed", "running"] },
	runId: { type: "string" },
	outputPath: { type: "string" },
	exitCode: { type: "number" },
	paneId: { type: "string" },
	error: { type: "string" },
	failure: { enum: ["launch", "run", "timeout", "cancelled"] },
};

const agentResultRequired = ["agent", "ok", "output", "state", "runId"];
const agentResultSchema = {
	oneOf: [
		{
			type: "object",
			properties: {
				...agentResultProperties,
				ok: { const: false },
				state: { const: "running" },
			},
			required: agentResultRequired,
			additionalProperties: false,
		},
		{
			type: "object",
			properties: {
				...agentResultProperties,
				ok: { const: true },
				state: { const: "done" },
			},
			required: agentResultRequired,
			additionalProperties: false,
		},
		{
			type: "object",
			properties: {
				...agentResultProperties,
				ok: { const: false },
				state: { const: "failed" },
			},
			required: agentResultRequired,
			additionalProperties: false,
		},
	],
};

const agentNamesSchema = { type: "array", items: { type: "string" } };

const batchStateSchema = { enum: ["running", "settled", "cancelled"] };

const agentBatchSnapshotSchema = {
	type: "object",
	properties: {
		runId: { type: "string" },
		agents: agentNamesSchema,
		state: batchStateSchema,
		startedAt: { type: "number" },
		elapsedMs: { type: "number" },
		detached: { type: "boolean" },
	},
	required: ["runId", "agents", "state", "startedAt", "elapsedMs", "detached"],
	additionalProperties: false,
};

const descriptors: ActionDescriptor[] = [
	{
		name: "models",
		description: "List permitted model overrides and the generic agent default.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		outputSchema: {
			type: "object",
			properties: {
				defaultModel: { type: ["string", "null"] },
				models: { type: "array", items: modelCatalogEntrySchema },
			},
			required: ["defaultModel", "models"],
			additionalProperties: false,
		},
		exposure: "deferred",
	},
	{
		name: "list",
		description: "List discoverable custom and generic agent definitions.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		outputSchema: {
			type: "array",
			items: {
				type: "object",
				properties: {
					name: { type: "string" },
					scope: { enum: ["user", "project", "builtin"] },
					description: { type: "string" },
				},
				required: ["name", "scope"],
				additionalProperties: false,
			},
		},
		exposure: "deferred",
	},
	{
		name: "run",
		description: "Run one task and wait up to `waitMs` for its result or a running handle.",
		inputSchema: runItemSchema,
		outputSchema: agentResultSchema,
	},
	{
		name: "runAll",
		description: "Run tasks in parallel and wait up to `waitMs` for results or running handles.",
		inputSchema: {
			type: "object",
			properties: {
				tasks: { type: "array", items: taskItemSchema },
				waitMs: waitMsProperty,
			},
			required: ["tasks"],
			additionalProperties: false,
		},
		outputSchema: { type: "array", items: agentResultSchema },
	},
	{
		name: "start",
		description: "Launch a task or batch without waiting and return its run handle.",
		inputSchema: startSchema,
		outputSchema: {
			type: "object",
			properties: { runId: { type: "string" }, agents: agentNamesSchema, state: { const: "running" } },
			required: ["runId", "agents", "state"],
			additionalProperties: false,
		},
	},
	{
		name: "wait",
		description: "Wait up to `waitMs` for a run, returning running placeholders or terminal results.",
		inputSchema: {
			type: "object",
			properties: { runId: { type: "string" }, waitMs: waitMsProperty, timeoutMs: waitTimeoutMsAliasProperty },
			required: ["runId"],
			additionalProperties: false,
		},
		outputSchema: {
			type: "object",
			properties: {
				runId: { type: "string" },
				state: batchStateSchema,
				elapsedMs: { type: "number" },
				agents: agentNamesSchema,
				results: { type: "array", items: agentResultSchema },
			},
			required: ["runId", "state", "elapsedMs", "agents", "results"],
			additionalProperties: false,
		},
	},
	{
		name: "status",
		description: "List live and recent batches without their outputs.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		outputSchema: { type: "array", items: agentBatchSnapshotSchema },
		exposure: "deferred",
	},
	{
		name: "cancel",
		description: "Cancel one batch by `runId`, or all live batches when omitted.",
		inputSchema: {
			type: "object",
			properties: { runId: { type: "string" } },
			additionalProperties: false,
		},
		outputSchema: {
			type: "object",
			properties: { cancelled: agentNamesSchema },
			required: ["cancelled"],
			additionalProperties: false,
		},
		exposure: "deferred",
	},
];

for (const descriptor of descriptors) {
	const readOnly = ["models", "list", "status", "wait"].includes(descriptor.name);
	descriptor.annotations = {
		readOnlyHint: readOnly,
		destructiveHint: !readOnly,
		idempotentHint: ["models", "list", "status", "cancel"].includes(descriptor.name),
		openWorldHint: !readOnly && descriptor.name !== "cancel",
	};
}

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

const normalizedItem = (value: unknown): NormalizedItem => {
	const record =
		typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	const model = stringOrUndefined(record.model);
	const thinking = stringOrUndefined(record.thinking);
	const output = stringOrUndefined(record.output);
	const reads = stringArrayOrUndefined(record.reads);
	const night = record.night === true;
	const nightTodoId = stringOrUndefined(record.nightTodoId);
	return {
		...(record.agent === undefined ? {} : { agent: String(record.agent) }),
		task: String(record.task ?? ""),
		...(model ? { model } : {}),
		...(thinking ? { thinking } : {}),
		...(output ? { output } : {}),
		...(reads ? { reads } : {}),
		...(night ? { night } : {}),
		...(nightTodoId ? { nightTodoId } : {}),
	};
};

const agentResult = (result: RunResult, runId: string): AgentResult => ({
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
const pendingResult = (agent: string, runId: string, elapsedMs: number): AgentResult => ({
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

export function bindApprovedNightTasks(
	items: NormalizedItem[],
	run: ActiveNightRun | undefined = readActiveNightRun(),
	ref: { sessionId?: string; cwd?: string } = {},
): NormalizedItem[] {
	if (!run?.approvedTaskIds?.length || !isNightRunParticipant(run, ref)) return items;
	const approved = new Set(run.approvedTaskIds.map((id) => id.toLowerCase()));
	return items.map((item) => {
		const rawId = item.nightTodoId
			?.replace(/^TODO-/i, "")
			.trim()
			.toLowerCase();
		if (!rawId) {
			throw new Error(
				"An active night run may launch only approved work. Pass nightTodoId for the approved ledger item.",
			);
		}
		if (!approved.has(rawId)) throw new Error(`Night ledger item TODO-${rawId} was not approved for this run.`);
		return {
			...item,
			night: true,
			nightTodoId: rawId,
			task: `Approved ledger item: TODO-${rawId}\n\n${item.task}`,
		};
	});
}

export class AgentsProvider implements ActionProvider {
	readonly name = "agents";
	readonly description =
		"Custom markdown agents discovered on disk, run as child Pi sessions (headless, or live herdr panes)";
	readonly instructions = [
		"Use tools.agents_run for one task or tools.agents_runAll for a batch when waiting in this turn is appropriate. Their wait window is bounded by waitMs; a result with state 'running' is a live handle, not a failed task.",
		"Use tools.agents_start to detach a task or batch immediately, then tools.agents_wait({ runId, waitMs }) to claim results or keep waiting. Use tools.agents_cancel({ runId }) to stop it. Unclaimed completions are delivered to the parent as a follow-up.",
		"Omit agent to use the generic task agent, which inherits the parent model, tools, skills and project context. tools.agents_list discovers named definitions; tools.agents_models lists permitted model override IDs and the generic default.",
		"A task accepts optional model, thinking, output, reads, night, and nightTodoId fields. Batch timing belongs to the action, not each task. tools.agents_wait also accepts timeoutMs as an alias for waitMs, with waitMs taking precedence.",
		"The child lifetime and model authorization are host policy. Do not pass a working directory or attempt to bypass the configured provider, enabled-model, or price restrictions.",
	].join("\n");

	constructor(
		readonly session: () => SessionRef,
		readonly registry: AgentRunRegistry,
		readonly runtimeConfig: () => AgentRuntimeConfig,
		/** Live batches, so a run can outlive the program that started it. */
		readonly runs: AgentRuns = new AgentRunBook(),
		/** Adapter selection and herdr drift containment (see backend.ts). */
		readonly launcher: RunLauncher = new RunLauncher(),
		/** Refuses to relaunch into a fault that already proved itself. */
		readonly breaker: CauseBreaker = new CauseBreaker(),
	) {}

	/** Whether the launch fault is currently journaled, so it is logged once. */
	#launchBroken = false;
	#closing = false;

	async close(options: { preserveRuns?: boolean } = {}): Promise<void> {
		this.#closing = true;
		this.runs.setSink(undefined);
		if (options.preserveRuns && this.runs.suspend) {
			await this.runs.suspend();
			return;
		}
		await this.runs.drain(5_000);
	}

	async list(_request: ActionListRequest, _context: ActionContext): Promise<ActionDescriptor[]> {
		return descriptors;
	}

	async describe(actionName: string, _context: ActionContext): Promise<ActionDescriptor | undefined> {
		return descriptors.find((descriptor) => descriptor.name === actionName);
	}

	/**
	 * Canonicalize near-miss argument spellings (prompt -> task, id -> runId,
	 * "5000" -> 5000) from the declared schemas before validation rejects them.
	 */
	prepareArguments(actionName: string, args: Record<string, unknown>): Record<string, unknown> {
		return normalizeAgentArgs(actionName, args);
	}

	async invoke(actionName: string, args: Record<string, unknown>, context: ActionContext): Promise<unknown> {
		if (this.#closing) throw new Error("Subagents session is shutting down");
		const ref = this.session();
		const runtime = this.runtimeConfig();
		const waitMs = (): number => boundedMs(args.waitMs, runtime.waitMs, 0, MAX_AGENT_TIMEOUT_MS);
		switch (actionName) {
			case "models":
				return {
					defaultModel: qualifyModel(runtime.defaultModel, runtime.parentProvider) ?? null,
					models: (runtime.models ?? [])
						.filter((model) => {
							const id = `${model.provider}/${model.id}`;
							return (
								(!runtime.parentProvider || model.provider === runtime.parentProvider) &&
								!validateOverrides([{ task: "", model: id }], ref.cwd) &&
								!subagentModelPriceError(id, runtime.models ?? [], runtime.parentProvider)
							);
						})
						.map((model) => ({
							id: `${model.provider}/${model.id}`,
							name: model.name,
							provider: model.provider,
							reasoning: model.reasoning,
							input: model.input,
							contextWindow: model.contextWindow,
							maxTokens: model.maxTokens,
						})),
				};
			case "list":
				return discoverAgentsForCwd(ref.cwd).map((agent) => ({
					name: agent.config.name,
					scope: agent.scope,
					...(agent.config.description ? { description: agent.config.description } : {}),
				}));
			case "run": {
				const batch = await this.#launch(tasksOf(args, "agents.run"), context, { attach: true });
				const outcome = await this.runs.wait(batch.runId, waitMs());
				const first = this.#resultsOf(batch, outcome)[0];
				if (!first) throw new Error("agents.run produced no result");
				return first;
			}
			case "runAll": {
				if (!Array.isArray(args.tasks) || args.tasks.length === 0) {
					throw new Error("agents.runAll requires a non-empty tasks array");
				}
				const batch = await this.#launch(tasksOf(args, "agents.runAll"), context, { attach: true });
				const outcome = await this.runs.wait(batch.runId, waitMs());
				return this.#resultsOf(batch, outcome);
			}
			case "start": {
				// Detached on purpose: no link to this turn's abort signal, so the run
				// survives the program that launched it.
				const batch = await this.#launch(tasksOf(args, "agents.start"), context, { attach: false });
				return { runId: batch.runId, agents: batch.agents, state: "running" as const };
			}
			case "wait": {
				const runId = stringOrUndefined(args.runId);
				if (!runId) throw new Error("agents.wait requires a runId");
				// `timeoutMs` is a wait-window alias; `waitMs` wins if both are set.
				const window = boundedMs(args.waitMs ?? args.timeoutMs, runtime.waitMs, 0, MAX_AGENT_TIMEOUT_MS);
				const outcome = await this.runs.wait(runId, window);
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
				return await this.runs.list();
			case "cancel":
				return { cancelled: await this.runs.cancel(stringOrUndefined(args.runId)) };
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
		// Publish the transition, once each way, into the night run's capability
		// journal: the finding that the runner is down is exactly what died with the
		// run on 2026-09-02, leaving the next night to rediscover it.
		const verdict = this.breaker.verdict();
		if (verdict && !this.#launchBroken) {
			this.#launchBroken = true;
			recordNightCapability("subagent-launch", "broken", verdict.error);
		} else if (!verdict && this.#launchBroken) {
			this.#launchBroken = false;
			recordNightCapability("subagent-launch", "working");
		}
	}

	/** Settled results, or one pending placeholder per agent still running. */
	#resultsOf(batch: LaunchedBatch, outcome: AgentWaitOutcome): AgentResult[] {
		if (outcome.results) return outcome.results;
		return batch.agents.map((agent) => pendingResult(agent, batch.runId, outcome.snapshot.elapsedMs));
	}

	/**
	 * Resolve raw items to run requests: discover the agents (always at least the
	 * built-in personaless one), apply runtime defaults only where the selected
	 * agent has no setting, then build and validate the requests. Pure of UI and
	 * spawning.
	 */
	#resolveRequests(items: NormalizedItem[], ref: SessionRef, runtimeConfig: AgentRuntimeConfig): RunRequest[] {
		const discovered = discoverAgentsForCwd(ref.cwd);
		const withDefaults = items.map((item) => {
			const agent = discovered.find((candidate) => candidate.config.name === (item.agent ?? BUILTIN_AGENT_NAME));
			const model = item.model ?? agent?.config.model ?? runtimeConfig.defaultModel;
			const hasThinking = item.thinking || extractThinkingSuffix(model ?? "") || agent?.config.thinking;
			return {
				...item,
				...(item.model || agent?.config.model || !runtimeConfig.defaultModel
					? {}
					: { model: runtimeConfig.defaultModel }),
				...(hasThinking || !runtimeConfig.defaultThinking ? {} : { thinking: runtimeConfig.defaultThinking }),
			};
		});
		const built = buildRunRequests(
			{ tasks: withDefaults },
			discovered,
			ref.cwd,
			runtimeConfig.models,
			runtimeConfig.parentProvider,
		);
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
		context: ActionContext,
		options: { attach: boolean },
	): Promise<LaunchedBatch> {
		const ref = this.session();
		const runtimeConfig = this.runtimeConfig();
		items = bindApprovedNightTasks(items, undefined, { sessionId: ref.sessionId, cwd: ref.cwd });
		const requests = this.#resolveRequests(items, ref, runtimeConfig);

		const runId = newRunId();

		// Host-side placement: a child of a night run gets its own jj workspace so
		// two subagents never share a working copy. Nothing here comes from the
		// model; `cwd` is not part of the tool schema.
		const workspaces = await allocateNightWorkspaces(requests, runId, ref.cwd);

		// One selection per process (the herdr dialect probe runs at most once):
		// a drifted herdr CLI degrades to headless instead of failing the batch.
		let selection: Awaited<ReturnType<RunLauncher["selection"]>>;
		try {
			if (this.#closing) throw new Error("Subagents session is shutting down");
			selection = await this.launcher.selection();
			if (this.#closing) throw new Error("Subagents session is shutting down");
		} catch (error) {
			await releaseNightWorkspaces(workspaces);
			throw error;
		}
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
			void Promise.resolve(this.runs.cancel(runId)).catch(() => controller.abort());
		};
		const unlink = (): void => parentSignal?.removeEventListener("abort", onParentAbort);

		const configuredTimeoutMs = runtimeConfig.timeoutMs || DEFAULT_SUBAGENTS_CONFIG.timeoutMs;
		const runContext: RunContext = {
			sessionId: ref.sessionId,
			sessionFile: ref.sessionFile,
			runId,
			cwd: ref.cwd,
			// Inherited, not re-derived: a child in a fresh working copy would
			// otherwise stop on pi's project-trust prompt with no tty to answer.
			projectTrusted: ref.projectTrusted === true,
			// Child lifetime is host policy, not a per-call model choice.
			timeoutMs: configuredTimeoutMs,
			signal: controller.signal,
			onStatus: monitor.onStatus,
		};

		const execute = async (): Promise<AgentResult[]> => {
			try {
				if (controller.signal.aborted) {
					return requests.map((request) => ({
						agent: request.agent.config.name,
						ok: false,
						output: "(cancelled before launch)",
						state: "failed" as const,
						runId,
						error: "cancelled before launch",
						failure: "cancelled" as const,
					}));
				}
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
		};
		// A durable book commits admission before any child process is launched.
		let resolve!: (results: AgentResult[]) => void;
		let reject!: (error: unknown) => void;
		const promise = new Promise<AgentResult[]>((accept, fail) => {
			resolve = accept;
			reject = fail;
		});

		const agents = requests.map((request) => request.agent.config.name);
		try {
			await this.runs.register({
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
		} catch (error) {
			unlink();
			monitor.stop();
			await releaseNightWorkspaces(workspaces);
			throw error;
		}

		// The batch is registered before the link is armed, so the cancel path
		// always finds it. No await separates the two.
		try {
			if (this.#closing || parentSignal?.aborted) await this.runs.cancel(runId);
			else parentSignal?.addEventListener("abort", onParentAbort, { once: true });
			if (!options.attach) monitor.stop();
		} catch (error) {
			controller.abort();
			void execute().then(resolve, reject);
			throw error;
		}
		void execute().then(resolve, reject);

		return { runId, agents };
	}
}
