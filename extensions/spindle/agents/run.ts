/**
 * Shared run types and output-file reading helpers used by both backends.
 */

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { buildChildArgs } from "./pi-args.ts";
import { ensureDir, resolveOutputOverride, runPaths } from "./paths.ts";
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
	 * child's `submit_result` writes here instead of the auto run-dir path, so
	 * callers can persist artifacts at stable locations (e.g. `.pi/goal/plan.md`).
	 */
	output?: string;
	/**
	 * Files the child should read for context before starting. Injected into the
	 * task message as a read-first instruction; the agent still needs a `read`
	 * tool to open them.
	 */
	reads?: string[];
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

export interface RunResult {
	agent: string;
	scope: string;
	ok: boolean;
	output: string;
	outputPath: string;
	/** Populated for the headless backend; undefined for herdr panes. */
	exitCode?: number;
	/** Populated for herdr runs. */
	paneId?: string;
	error?: string;
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

	const outputPath = req.output ? resolveOutputOverride(ctx.cwd, req.output) : paths.outputPath;

	const hasPrompt = req.agent.systemPrompt.trim().length > 0;
	if (hasPrompt) writeSystemPrompt(paths.promptPath, req.agent.systemPrompt);

	const childArgs = buildChildArgs(req.agent, req.task, {
		sessionFile: paths.sessionPath,
		outputPath,
		systemPromptFile: hasPrompt ? paths.promptPath : undefined,
		defaultProvider: opts.defaultProvider,
		modelOverride: req.overrides?.model,
		thinkingOverride: req.overrides?.thinking,
		reads: req.reads,
		includeTask: opts.includeTask,
	});

	return { dir: paths.dir, outputPath, sessionPath: paths.sessionPath, promptPath: paths.promptPath, hasPrompt, childArgs };
}

interface Snapshot {
	exists: boolean;
	size: number;
	mtimeMs: number;
}

function snapshot(path: string): Snapshot {
	try {
		const st = statSync(path);
		return { exists: true, size: st.size, mtimeMs: st.mtimeMs };
	} catch {
		return { exists: false, size: 0, mtimeMs: 0 };
	}
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isStable(a: Snapshot, b: Snapshot): boolean {
	return a.exists && b.exists && a.size === b.size && a.mtimeMs === b.mtimeMs && b.size > 0;
}

/**
 * Why a run finished waiting:
 * - `stable`   the output file appeared and stopped changing (success path)
 * - `finished` the agent went idle/exited without producing a stable file
 * - `gone`     the pane vanished (e.g. the user terminated the subagent)
 * - `timeout`  none of the above happened before the deadline
 */
export type RunOutcome = "stable" | "finished" | "gone" | "timeout";

/**
 * Wait for a run to complete by racing two signals: the output file becoming
 * stable (polled cheaply via fs.stat), and an optional `agentSignal` promise
 * that resolves when the agent finishes (`finished`) or its pane is terminated
 * (`gone`). The agentSignal is expected to come from a blocking herdr wait, so
 * no process polling happens here.
 *
 * The file check is the success path. When the agent signal fires we still allow
 * a short grace window for a final write to land, preferring `stable` if it does.
 */
export async function waitForRunCompletion(
	path: string,
	opts: {
		timeoutMs: number;
		intervalMs?: number;
		graceMs?: number;
		agentSignal?: Promise<"finished" | "gone">;
	},
): Promise<RunOutcome> {
	const interval = opts.intervalMs ?? 400;
	const grace = opts.graceMs ?? 2500;
	const deadline = Date.now() + opts.timeoutMs;

	let signal: "finished" | "gone" | undefined;
	opts.agentSignal?.then((s) => {
		signal = s;
	}).catch(() => {});

	let prev = snapshot(path);
	while (Date.now() < deadline) {
		await sleep(interval);
		const cur = snapshot(path);
		if (isStable(prev, cur)) return "stable";
		prev = cur;

		if (signal) {
			// Grace: give a final write a chance to land before finalizing.
			const graceDeadline = Math.min(deadline, Date.now() + grace);
			let gp = snapshot(path);
			while (Date.now() < graceDeadline) {
				await sleep(interval);
				const gc = snapshot(path);
				if (isStable(gp, gc)) return "stable";
				gp = gc;
			}
			return signal;
		}
	}
	return "timeout";
}

export function readOutputFile(path: string): string | undefined {
	try {
		const text = readFileSync(path, "utf-8");
		return text.length > 0 ? text : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Recover a run's result from the child pi session transcript when the output
 * file is missing. Agents sometimes end their turn with a plain assistant
 * message instead of calling the submit_result tool (reviewers are especially
 * prone to this), which leaves a complete answer on disk but no output file.
 * Returns the concatenated text of the last assistant message, or undefined
 * when the transcript is unreadable or has no assistant text.
 */
export function readLastAssistantText(sessionPath: string): string | undefined {
	let raw: string;
	try {
		raw = readFileSync(sessionPath, "utf-8");
	} catch {
		return undefined;
	}
	let last: string | undefined;
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) continue;
		let obj: unknown;
		try {
			obj = JSON.parse(trimmed);
		} catch {
			continue;
		}
		const msg = (obj as { message?: { role?: unknown; content?: unknown } }).message;
		if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		const text = msg.content
			.filter(
				(c): c is { type: string; text: string } =>
					!!c &&
					typeof c === "object" &&
					(c as { type?: unknown }).type === "text" &&
					typeof (c as { text?: unknown }).text === "string",
			)
			.map((c) => c.text)
			.join("")
			.trim();
		if (text.length > 0) last = text;
	}
	return last;
}

export interface ResolvedOutput {
	output: string;
	ok: boolean;
}

/**
 * Resolve a run's final output and success, applying the three-tier rule both
 * backends share: the `submit_result` file first, then the child session
 * transcript (agents sometimes end with a plain message instead of calling
 * submit_result), then a backend-specific `fallback` (headless: captured stdout;
 * herdr: pane scrollback). The fallback is an async thunk so it runs only when
 * the first two tiers miss, avoiding needless work.
 *
 * A run is `ok` when it produced usable output AND finished cleanly
 * (`finishedCleanly`: headless exit 0; herdr a stable/finished outcome). When no
 * source yields text, `output` is a placeholder and `ok` is false.
 */
export async function resolveRunOutput(opts: {
	outputPath: string;
	sessionPath: string;
	fallback: () => Promise<string | undefined> | string | undefined;
	finishedCleanly: boolean;
	placeholder?: string;
}): Promise<ResolvedOutput> {
	let output = readOutputFile(opts.outputPath) ?? readLastAssistantText(opts.sessionPath);
	if (output === undefined) output = (await opts.fallback()) || undefined;
	const ok = output !== undefined && opts.finishedCleanly;
	return { output: output ?? (opts.placeholder ?? "(no output produced)"), ok };
}
