/** Shared durable worker inputs and result helpers. */

import { type ResolvedOutput } from "./output.ts";
import { type DiscoveredAgent } from "./discovery.ts";
import type { ActiveNightRun } from "../night-mode/night-run.ts";

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
	outputPath?: string;
}

/**
 * Optional callback the durable backend invokes on lifecycle transitions so the tool
 * can stream a compact live indicator. `index` matches `RunRequest.index`.
 */
export type OnStatus = (index: number, update: RunStatusUpdate) => void;

/** Parent identity, policy, lifetime and cancellation inputs for a durable batch. */
export interface RunContext {
	sessionId: string | undefined;
	sessionFile: string | undefined;
	runId: string;
	cwd: string;
	timeoutMs: number;
	/** Admission-time deadline, retained on recovery instead of resetting the lifetime. */
	deadlineAt?: number;
	/** Host-only approved night contract retained with the admission across restart. */
	nightRun?: ActiveNightRun;
	/**
	 * Whether the parent session trusts the project-local files at its cwd,
	 * inherited by the native resource loader. Inherited rather
	 * than re-derived, because pi trusts by path: a child started in a fresh
	 * working copy is untrusted and would stop on the prompt.
	 */
	projectTrusted?: boolean;
	signal?: AbortSignal;
	onStatus?: OnStatus;
}

/** Give a child a private writable config home without dropping its inherited environment. */
export function withChildConfigHome(configHome: string | undefined, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return configHome ? { ...base, XDG_CONFIG_HOME: configHome } : base;
}

/** Batch execution seam retained for supervisor reloads and offline tests. */
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

/** Durable result and stable child conversation identity. */
export type RunResult = RunResultBase & { backend: "durable"; conversationId?: string; exitCode?: number };

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
