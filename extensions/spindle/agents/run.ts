/**
 * Shared run types and output-file reading helpers used by both backends.
 */

import { writeFileSync } from "node:fs";
import { buildChildArgs } from "./pi-args.ts";
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
 * once and hands it to whichever backend `selectBackend` returns.
 */
export interface RunContext {
	sessionId: string | undefined;
	sessionFile: string | undefined;
	runId: string;
	cwd: string;
	timeoutMs: number;
	signal?: AbortSignal;
	onStatus?: OnStatus;
}

/**
 * The run-backend seam: turn a batch of requests into results. Two adapters
 * implement it (headless child processes, live herdr panes); `selectBackend`
 * (see backend.ts) picks one by environment. Batch-shaped because the herdr
 * adapter needs the whole batch at once to tile its pane grid; the headless
 * adapter fans out with Promise.all internally.
 */
export type RunBackend = (reqs: RunRequest[], ctx: RunContext) => Promise<RunResult[]>;

export interface RunResultBase {
	agent: string;
	scope: string;
	ok: boolean;
	output: string;
	outputPath: string;
	error?: string;
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
 */
export function baseResult(
	req: RunRequest,
	outputPath: string,
	resolved: ResolvedOutput,
	error?: string,
): RunResultBase {
	return {
		agent: req.agent.config.name,
		scope: req.agent.scope,
		ok: resolved.ok,
		output: resolved.output,
		outputPath,
		...(error ? { error } : {}),
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
}

/**
 * Prepare a single run's on-disk files and child `pi` args. This is the setup
 * both backends share: resolve the run dir, honor a per-run `output` override,
 * write the system prompt when present, and build the child args. The only
 * per-backend knob is `includeTask`: the headless adapter inlines the task as
 * the initial message, while the herdr adapter omits it here and submits it via
 * `agent prompt` (which handles multi-line text `agent start` cannot encode).
 */
export function prepareChildRun(
	req: RunRequest,
	ctx: RunContext,
	opts: { defaultProvider: string | undefined; includeTask: boolean },
): PreparedRun {
	const paths = runPaths(ctx.sessionFile, ctx.sessionId, ctx.runId, req.agent.config.name, req.index);
	ensureRunDir(paths.dir);

	const outputPath = outputPathFor(ctx.cwd, paths.outputPath, req.output);

	const hasPrompt = req.agent.systemPrompt.trim().length > 0;
	if (hasPrompt) writeSystemPrompt(paths.promptPath, req.agent.systemPrompt);

	const childArgs = buildChildArgs(req.agent, req.task, {
		sessionFile: paths.sessionPath,
		systemPromptFile: hasPrompt ? paths.promptPath : undefined,
		defaultProvider: opts.defaultProvider,
		modelOverride: req.overrides?.model,
		thinkingOverride: req.overrides?.thinking,
		reads: req.reads,
		night: req.night,
		includeTask: opts.includeTask,
	});

	return { dir: paths.dir, outputPath, sessionPath: paths.sessionPath, promptPath: paths.promptPath, hasPrompt, childArgs };
}


