/**
 * The `subagent` tool: list discovered agents, or run one/several of them.
 *
 * Shapes (exactly one must be provided):
 *   - { action: "list" }
 *   - { agent, task }                       single run
 *   - { tasks: [{ agent, task }, ...] }      parallel run (blocks until all finish)
 *
 * Backend selection is by environment: live herdr panes when in herdr,
 * otherwise headless `pi` child processes.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type DiscoveredAgent, discoverAgentsForCwd } from "./discovery.ts";
import { runHeadless } from "./headless.ts";
import { isInHerdr } from "./herdr.ts";
import { runInHerdr } from "./herdr-backend.ts";
import { newRunId } from "./paths.ts";
import { type RunRequest, type RunResult, type RunState, type RunStatusUpdate } from "./run.ts";

export interface SessionRef {
	sessionId: string | undefined;
	sessionFile: string | undefined;
	cwd: string;
}

type TextResult = { content: { type: "text"; text: string }[]; details: undefined };

function text(body: string): TextResult {
	return { content: [{ type: "text", text: body }], details: undefined };
}

const DEFAULT_RUN_TIMEOUT_MS = 30 * 60 * 1000;
const PROGRESS_TICK_MS = 100;

/** Per-agent live progress row for the in-progress indicator. */
export interface AgentProgress {
	name: string;
	scope: string;
	state: RunState;
	startedAt: number;
	/** Stamped when the row reaches a terminal state so its elapsed freezes. */
	endedAt?: number;
	paneId?: string;
	outputPath?: string;
}

const STATE_LABEL: Record<RunState, string> = {
	spawning: "spawning",
	running: "running",
	done: "done",
	failed: "FAILED",
};

/** Braille spinner frames for active rows; advanced by the caller each tick. */
export const SPINNER_FRAMES = ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"];
const ANSI = { green: "\u001b[32m", red: "\u001b[31m", orange: "\u001b[38;5;208m", reset: "\u001b[0m" };

/** Status glyph for a row: spinner while active, check/cross when terminal. */
export function stateGlyph(state: RunState, frame: number): string {
	if (state === "done") return "\u2713";
	if (state === "failed") return "\u2717";
	return SPINNER_FRAMES[((frame % SPINNER_FRAMES.length) + SPINNER_FRAMES.length) % SPINNER_FRAMES.length];
}

/** Format an elapsed duration compactly: "5s", "1m05s". */
export function formatElapsed(ms: number): string {
	const clamped = ms > 0 ? ms : 0;
	const totalSec = Math.floor(clamped / 1000);
	if (totalSec < 60) return `${totalSec}s`;
	const min = Math.floor(totalSec / 60);
	const sec = totalSec % 60;
	return `${min}m${String(sec).padStart(2, "0")}s`;
}

/**
 * Pure renderer for the live indicator. `now` and `frame` are injected so callers
 * (and tests) control elapsed time and the spinner deterministically. Terminal
 * rows freeze their elapsed at `endedAt`. `color` opt-in wraps terminal glyphs in
 * ANSI (best-effort; ignored/stripped harmlessly when the view is plain text).
 */
export function renderProgress(
	model: AgentProgress[],
	now: number,
	opts: { frame?: number; color?: boolean } = {},
): string {
	const frame = opts.frame ?? 0;
	const active = model.filter((m) => m.state === "spawning" || m.state === "running").length;
	const noun = model.length === 1 ? "subagent" : "subagents";
	const header = active > 0
		? `Running ${model.length} ${noun} (${active} active):`
		: `Subagents (${model.length}):`;
	const lines = [header];
	for (const m of model) {
		const elapsed = formatElapsed((m.endedAt ?? now) - m.startedAt);
		const parts = [`[${STATE_LABEL[m.state]}]`, elapsed];
		if (m.paneId) parts.push(`pane ${m.paneId}`);
		if (m.outputPath) parts.push(`output: ${m.outputPath}`);
		lines.push(`- ${colorGlyph(stateGlyph(m.state, frame), m.state, opts.color)} ${m.name} ${parts.join(" \u00b7 ")}`);
	}
	return lines.join("\n");
}

function colorGlyph(glyph: string, state: RunState, color: boolean | undefined): string {
	if (!color) return glyph;
	if (state === "done") return `${ANSI.green}${glyph}${ANSI.reset}`;
	if (state === "failed") return `${ANSI.red}${glyph}${ANSI.reset}`;
	if (state === "spawning" || state === "running") return `${ANSI.orange}${glyph}${ANSI.reset}`;
	return glyph;
}

/**
 * Apply a status update to the progress row at `index` (mutates in place). When
 * the row reaches a terminal state, stamp `endedAt` (once) so its elapsed stops.
 */
export function applyStatus(model: AgentProgress[], index: number, update: RunStatusUpdate, now = Date.now()): void {
	const row = model[index];
	if (!row) return;
	row.state = update.state;
	if (update.paneId !== undefined) row.paneId = update.paneId;
	if (update.outputPath !== undefined) row.outputPath = update.outputPath;
	if ((update.state === "done" || update.state === "failed") && row.endedAt === undefined) {
		row.endedAt = now;
	}
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of a discovered agent to run" }),
	task: Type.String({ description: "The concrete task for that agent" }),
});

export function createSubagentTool(getSessionRef: () => SessionRef) {
	return defineTool({
		name: "subagent",
		label: "subagent",
		description:
			"Delegate work to a custom agent. Use { action: \"list\" } to see available agents, " +
			"{ agent, task } to run one, or { tasks: [{ agent, task }, ...] } to run several in parallel " +
			"(waits for all to finish). In herdr, each subagent runs in a live pane inside a dedicated " +
			"'subagents' tab so you can watch and interact; otherwise it runs headlessly.",
		promptSnippet: "List or run custom subagents (headless, or live herdr panes)",
		parameters: Type.Object({
			action: Type.Optional(Type.Literal("list", { description: "List available agents" })),
			agent: Type.Optional(Type.String({ description: "Agent name for a single run" })),
			task: Type.Optional(Type.String({ description: "Task for a single run" })),
			tasks: Type.Optional(Type.Array(TaskItem, { description: "Multiple agent/task pairs to run in parallel" })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			const ref = getSessionRef();
			const agents = discoverAgentsForCwd(ref.cwd);

			if (params.action === "list") {
				return text(formatAgentList(agents));
			}

			const requested = normalizeRequests(params);
			if ("error" in requested) return text(requested.error);

			const resolved: RunRequest[] = [];
			for (let i = 0; i < requested.items.length; i++) {
				const item = requested.items[i];
				const agent = agents.find((a) => a.config.name === item.agent);
				if (!agent) {
					return text(unknownAgentError(item.agent, agents));
				}
				resolved.push({ agent, task: item.task, index: i });
			}

			const runId = newRunId();
			const startedAt = Date.now();
			const model: AgentProgress[] = resolved.map((req) => ({
				name: req.agent.config.name,
				scope: req.agent.scope,
				state: "spawning" as RunState,
				startedAt,
			}));

			let live = true;
			let frame = 0;
			const pushProgress = () => {
				if (live) onUpdate?.(text(renderProgress(model, Date.now(), { frame, color: true })));
			};
			pushProgress();
			const ticker = setInterval(() => {
				frame++;
				pushProgress();
			}, PROGRESS_TICK_MS);
			ticker.unref?.();

			const baseCtx = {
				sessionId: ref.sessionId,
				sessionFile: ref.sessionFile,
				runId,
				cwd: ref.cwd,
				timeoutMs: DEFAULT_RUN_TIMEOUT_MS,
				signal,
				onStatus: (index: number, update: RunStatusUpdate) => {
					applyStatus(model, index, update);
					pushProgress();
				},
			};

			let results: RunResult[];
			try {
				if (isInHerdr()) {
					results = await runInHerdr(resolved, baseCtx);
				} else {
					results = await Promise.all(resolved.map((req) => runHeadless(req, baseCtx)));
				}
			} finally {
				live = false;
				clearInterval(ticker);
			}

			// One final frame so the last live view shows the terminal ✓/✗ states.
			onUpdate?.(text(renderProgress(model, Date.now(), { frame, color: true })));

			return text(formatResults(results, ref));
		},
	});
}

function normalizeRequests(params: {
	agent?: string;
	task?: string;
	tasks?: { agent: string; task: string }[];
}): { items: { agent: string; task: string }[] } | { error: string } {
	const hasSingle = !!params.agent || !!params.task;
	const hasParallel = Array.isArray(params.tasks) && params.tasks.length > 0;

	if (hasSingle && hasParallel) {
		return { error: "Provide either { agent, task } or { tasks: [...] }, not both." };
	}
	if (hasParallel) {
		return { items: params.tasks! };
	}
	if (hasSingle) {
		if (!params.agent || !params.task) {
			return { error: "A single run needs both `agent` and `task`." };
		}
		return { items: [{ agent: params.agent, task: params.task }] };
	}
	return { error: "Nothing to do. Use { action: \"list\" }, { agent, task }, or { tasks: [...] }." };
}

function formatAgentList(agents: DiscoveredAgent[]): string {
	if (agents.length === 0) {
		return "No custom agents found under ~/.pi/agent/agents or <cwd>/.pi/agents.";
	}
	const lines = [`Available agents (${agents.length}):`];
	for (const a of agents) {
		const desc = a.config.description ? ` - ${a.config.description}` : "";
		lines.push(`- ${a.config.name} [${a.scope}]${desc}`);
	}
	return lines.join("\n");
}

function unknownAgentError(name: string, agents: DiscoveredAgent[]): string {
	const names = agents.map((a) => a.config.name).join(", ") || "(none)";
	return `Unknown agent '${name}'. Available: ${names}.`;
}

function formatResults(results: RunResult[], ref: SessionRef): string {
	const header: string[] = [];
	if (!ref.sessionId) {
		header.push("Note: no parent session id available; results are isolated under a per-process temp dir.");
	}
	const sections = results.map((r) => {
		const status = r.ok ? "ok" : "FAILED";
		const meta = [`status: ${status}`, `scope: ${r.scope}`];
		if (r.paneId) meta.push(`pane: ${r.paneId}`);
		if (r.exitCode !== undefined) meta.push(`exit: ${r.exitCode}`);
		if (r.error) meta.push(`error: ${r.error}`);
		return [
			`## ${r.ok ? "\u2713" : "\u2717"} ${r.agent} (${meta.join(", ")})`,
			r.output,
			`_output file: ${r.outputPath}_`,
		].join("\n\n");
	});
	return [...header, ...sections].join("\n\n");
}
