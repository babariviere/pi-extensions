/**
 * Shared run types and output-file reading helpers used by both backends.
 */

import { writeFileSync } from "node:fs";
import { buildChildArgs, formatTaskMessage, type TaskFraming } from "./pi-args.ts";
import { outputPathFor, type ResolvedOutput } from "./output.ts";
import { ensureDir, runPaths } from "./paths.ts";
import { type DiscoveredAgent } from "./discovery.ts";

export interface RunRequest {
	agent: DiscoveredAgent;
	task: string;
	index: number;
	/**
	 * Per-run overrides of the agent's frontmatter, used to diversify parallel
	 * runs (e.g. run the same reviewer on Opus and Sonnet to decorrelate errors).
	 * Undefined fields fall back to the agent config.
	 */
	overrides?: { model?: string; thinking?: string };
	/**
	 * Per-run output destination (relative to cwd or absolute). When set, the
	 * parent persists the resolved result here instead of at the auto run-dir
	 * path, so callers can save artifacts at stable locations (e.g.
	 * `.pi/goal/plan.md`).
	 */
	output?: string;
	/**
	 * Files the child should read for context before starting. Injected into the
	 * task message as a read-first instruction; the agent still needs a `read`
	 * tool to open them.
	 */
	reads?: string[];
	/**
	 * Run under the night-mode contract: the hard rules of an unattended
	 * overnight run (no questions, no outbound messages, draft PRs only) plus the
	 * report path are prepended to the task. No-op when no night run is active.
	 */
	night?: boolean;
	/**
	 * Working directory for the child, when it differs from the parent's.
	 *
	 * Host-only: absent from the tool schema and from `NormalizedItem`, so a model
	 * cannot pick where its subagent runs. The one producer today is the night
	 * workspace allocator (`night-workspace.ts`), which gives every child of a
	 * night run its own jj workspace.
	 */
	cwd?: string;
	/**
	 * Durable directory for the child's deliverables, when the host gave it one.
	 *
	 * Host-only, like `cwd`, and produced by the same allocator: a night child's
	 * working copy is deleted at the end of the batch, so anything it must hand
	 * back as a file goes here instead.
	 */
	artifactsDir?: string;
}

/** The directory a run's child process starts in. */
export function runCwd(req: RunRequest, ctx: RunContext): string {
	return req.cwd ?? ctx.cwd;
}

/** Live lifecycle state of a single run, surfaced to the in-progress indicator. */
export type RunState = "spawning" | "running" | "done" | "failed";

export interface RunStatusUpdate {
	state: RunState;
	paneId?: string;
	outputPath?: string;
}

/**
 * Optional callback both backends invoke on lifecycle transitions so the tool
 * can stream a compact live indicator. `index` matches `RunRequest.index`.
 */
export type OnStatus = (index: number, update: RunStatusUpdate) => void;

/**
 * Ambient inputs a backend needs to run a batch: the parent session it belongs
 * to, a shared `runId`, the cwd, a per-run timeout, an abort signal, and the
 * status callback. Both adapters take the same context, so the tool builds it
 * once and hands it to the run launcher (`backend.ts`), which picks the
 * adapter and contains herdr CLI drift.
 */
export interface RunContext {
	sessionId: string | undefined;
	sessionFile: string | undefined;
	runId: string;
	cwd: string;
	timeoutMs: number;
	/**
	 * Whether the parent session trusts the project-local files at its cwd,
	 * forwarded to the child as `--approve` / `--no-approve`. Inherited rather
	 * than re-derived, because pi trusts by path: a child started in a fresh
	 * working copy is untrusted and would stop on the prompt.
	 */
	projectTrusted?: boolean;
	/** Whether the parent session disabled the usage pacing guard. */
	pacingDisabled?: boolean;
	signal?: AbortSignal;
	onStatus?: OnStatus;
}

/**
 * Add the explicit pacing override to a child environment. Both launch
 * backends call this because pane launches do not inherit the parent process
 * environment, while headless launches normally do.
 */
export function withPacingDisabled(
	pacingDisabled: boolean | undefined,
	base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	return pacingDisabled ? { ...base, PI_USAGE_PACING: "off" } : base;
}

/**
 * The run-backend seam: turn a batch of requests into results. Two adapters
 * implement it (headless child processes, live herdr panes); the run launcher
 * (see backend.ts) picks one by environment. Batch-shaped because the herdr
 * adapter needs the whole batch at once to tile its pane grid; the headless
 * adapter fans out with Promise.all internally.
 */
export type RunBackend = (reqs: RunRequest[], ctx: RunContext) => Promise<RunResult[]>;

/**
 * Why a run failed, as a class rather than prose.
 *
 * The distinction the night of 2026-09-02 lacked: a `launch` failure is the
 * parent's or the terminal multiplexer's fault and says nothing about the task,
 * while `run` means a child really did work and came back with nothing usable.
 * Reported identically, the two are indistinguishable, and a coordinator faced
 * with 90 launch failures re-planned the task 14 times — shorter task, other
 * persona, other model — for a fault no task could have avoided.
 *
 *  - `launch`    the child was never started (or never confirmed): retrying the
 *                same task is pointless until the runner is fixed
 *  - `run`       the child ran and produced no usable final message
 *  - `timeout`   the child was still working at its deadline
 *  - `cancelled` the parent, or the user, tore it down
 */
export type RunFailure = "launch" | "run" | "timeout" | "cancelled";

export interface RunResultBase {
	agent: string;
	scope: string;
	ok: boolean;
	output: string;
	/** Where the result was persisted. Absent when nothing was written. */
	outputPath?: string;
	error?: string;
	/** Present only on a failure. See {@link RunFailure}. */
	failure?: RunFailure;
}

/**
 * A run's result. Backend-specific diagnostics live on the variant that
 * produces them (headless has an `exitCode`; herdr has a `paneId`), so a
 * consumer discriminates on `backend` rather than guessing which optional
 * field a result carries.
 */
export type RunResult =
	| (RunResultBase & { backend: "headless"; exitCode?: number })
	| (RunResultBase & { backend: "herdr"; paneId?: string });

/**
 * The fields every result shares, assembled from a run's request and its
 * resolved output. Each adapter spreads this, then adds its `backend` tag and
 * backend-specific diagnostics.
 *
 * `outputPath` comes from the resolved output, not from the *intended*
 * destination: it is present only when the result actually landed on disk, and
 * a failed write is folded into `error`. Reporting the intended path
 * unconditionally made the tool claim a file existed when it did not.
 */
export function baseResult(
	req: RunRequest,
	resolved: ResolvedOutput,
	error?: string,
	failure?: RunFailure,
): RunResultBase {
	const reason = [error, resolved.writeError].filter((v): v is string => !!v).join("; ");
	return {
		agent: req.agent.config.name,
		scope: req.agent.scope,
		ok: resolved.ok,
		output: resolved.output,
		...(resolved.outputPath ? { outputPath: resolved.outputPath } : {}),
		...(reason ? { error: reason } : {}),
		// A successful run has no failure class, whatever happened on the way.
		...(!resolved.ok && failure ? { failure } : {}),
	};
}

/** Write the agent's system-prompt body to disk so `pi` can load it. */
export function writeSystemPrompt(promptPath: string, body: string): void {
	writeFileSync(promptPath, body, { mode: 0o600 });
}

export function ensureRunDir(dir: string): void {
	ensureDir(dir);
}

/** The child-run files and args, prepared identically for both backends. */
export interface PreparedRun {
	dir: string;
	outputPath: string;
	sessionPath: string;
	promptPath: string;
	hasPrompt: boolean;
	childArgs: string[];
	/** Where the task was written, when it is delivered as a file. */
	taskPath?: string;
}

/** How a backend hands the task to its child. */
export type TaskDelivery = "inline" | "file";

/**
 * Prepare a single run's on-disk files and child `pi` args. This is the setup
 * both backends share: resolve the run dir, honor a per-run `output` override,
 * write the system prompt when present, and build the child args.
 *
 * The only per-backend knob is `taskDelivery`. The headless adapter inlines the
 * task as an argv entry, where any characters are safe. The Herdr adapter uses
 * a shell-backed `pane run` command, so it cannot safely carry
 * multi-line args, so the task is written to a file and the child's own Spindle
 * delivers it as the first user message (`task-delivery.ts`). Both paths frame
 * the task identically, through `formatTaskMessage`.
 */
export function prepareChildRun(
	req: RunRequest,
	ctx: RunContext,
	opts: { defaultProvider: string | undefined; taskDelivery: TaskDelivery },
): PreparedRun {
	const paths = runPaths(ctx.sessionFile, ctx.sessionId, ctx.runId, req.agent.config.name, req.index);
	ensureRunDir(paths.dir);

	const outputPath = outputPathFor(ctx.cwd, paths.outputPath, req.output);

	const hasPrompt = req.agent.systemPrompt.trim().length > 0;
	if (hasPrompt) writeSystemPrompt(paths.promptPath, req.agent.systemPrompt);

	// One framing for both delivery modes: the file and the inline arg carry the
	// same text, so a subagent's first message does not depend on its backend.
	const framing: TaskFraming = {
		...(req.reads ? { reads: req.reads } : {}),
		...(req.night ? { night: req.night } : {}),
		...(req.cwd ? { workspacePath: req.cwd } : {}),
		...(req.artifactsDir ? { artifactsDir: req.artifactsDir } : {}),
	};
	const taskPath = opts.taskDelivery === "file" ? paths.taskPath : undefined;
	if (taskPath) writeFileSync(taskPath, formatTaskMessage(req.task, framing), { mode: 0o600 });

	const childArgs = buildChildArgs(req.agent, req.task, {
		sessionFile: paths.sessionPath,
		systemPromptFile: hasPrompt ? paths.promptPath : undefined,
		defaultProvider: opts.defaultProvider,
		modelOverride: req.overrides?.model,
		thinkingOverride: req.overrides?.thinking,
		...framing,
		// Forward the parent's project-trust verdict so the child never prompts.
		projectTrusted: ctx.projectTrusted === true,
		includeTask: opts.taskDelivery === "inline",
		...(taskPath ? { taskFile: taskPath } : {}),
	});

	return {
		dir: paths.dir,
		outputPath,
		sessionPath: paths.sessionPath,
		promptPath: paths.promptPath,
		hasPrompt,
		childArgs,
		...(taskPath ? { taskPath } : {}),
	};
}
