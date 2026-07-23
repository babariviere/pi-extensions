/**
 * The `subagent` tool: list discovered agents, or run one/several of them.
 *
 * Shapes (exactly one must be provided):
 *   - { action: "list" }
 *   - { agent, task }                       single run
 *   - { tasks: [{ agent, task }, ...] }      parallel run (blocks until all finish)
 *
 * Backend selection is delegated to `selectBackend` (live herdr panes when in
 * herdr, otherwise headless `pi` child processes). This module owns only the
 * tool schema, the live-indicator ticker, and its own result text; request
 * validation lives in request.ts and rendering in progress.ts.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { selectBackend } from "./backend.ts";
import { type DiscoveredAgent, discoverAgentsForCwd } from "./discovery.ts";
import { newRunId } from "./paths.ts";
import { type AgentProgress, applyStatus, renderProgress } from "./progress.ts";
import { buildRunRequests } from "./request.ts";
import { type RunContext, type RunResult, type RunState, type RunStatusUpdate } from "./run.ts";

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

const MODEL_DESC =
	"Override the agent's model for this run (e.g. \"claude-sonnet-5\" or \"anthropic/claude-opus-4-8\"). " +
	"Use to diversify parallel runs and decorrelate errors (e.g. review on two model families). " +
	"Must be one of the user's enabledModels when that allowlist is configured; unavailable/pricey models are rejected.";
const THINKING_DESC = "Override the agent's thinking level for this run (off|minimal|low|medium|high|xhigh).";
const OUTPUT_DESC =
	"Persist this run's result at this path (relative to cwd or absolute) instead of the auto run-dir file. " +
	"The harness routes the agent's submit_result here, so read-only agents still produce a stable artifact " +
	"(e.g. \".pi/goal/plan.md\"). Do not tell the agent to write the file itself.";
const READS_DESC =
	"Files the agent should read first for context (relative to cwd or absolute). Injected as a read-first " +
	"instruction; the agent still needs a `read` tool to open them.";

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of a discovered agent to run" }),
	task: Type.String({ description: "The concrete task for that agent" }),
	model: Type.Optional(Type.String({ description: MODEL_DESC })),
	thinking: Type.Optional(Type.String({ description: THINKING_DESC })),
	output: Type.Optional(Type.String({ description: OUTPUT_DESC })),
	reads: Type.Optional(Type.Array(Type.String(), { description: READS_DESC })),
});

export function createSubagentTool(getSessionRef: () => SessionRef) {
	return defineTool({
		name: "subagent",
		label: "subagent",
		description:
			"Delegate work to a custom agent. Use { action: \"list\" } to see available agents, " +
			"{ agent, task } to run one, or { tasks: [{ agent, task }, ...] } to run several in parallel " +
			"(waits for all to finish). Each run may set an optional `model`/`thinking` to override the " +
			"agent's frontmatter, `output` to persist the result at a stable path (e.g. \".pi/goal/plan.md\"), " +
			"and `reads` to list context files the agent should read first. In herdr, each " +
			"subagent runs in a live pane inside a dedicated 'subagents' tab so you can watch and interact; " +
			"otherwise it runs headlessly.",
		promptSnippet: "List or run custom subagents (headless, or live herdr panes)",
		parameters: Type.Object({
			action: Type.Optional(Type.Literal("list", { description: "List available agents" })),
			agent: Type.Optional(Type.String({ description: "Agent name for a single run" })),
			task: Type.Optional(Type.String({ description: "Task for a single run" })),
			model: Type.Optional(Type.String({ description: MODEL_DESC })),
			thinking: Type.Optional(Type.String({ description: THINKING_DESC })),
			output: Type.Optional(Type.String({ description: OUTPUT_DESC })),
			reads: Type.Optional(Type.Array(Type.String(), { description: READS_DESC })),
			tasks: Type.Optional(Type.Array(TaskItem, { description: "Multiple agent/task pairs to run in parallel" })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			const ref = getSessionRef();
			const agents = discoverAgentsForCwd(ref.cwd);

			if (params.action === "list") {
				return text(formatAgentList(agents));
			}

			const built = buildRunRequests(params, agents, ref.cwd);
			if ("error" in built) return text(built.error);
			const resolved = built.requests;

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

			const baseCtx: RunContext = {
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
				results = await selectBackend()(resolved, baseCtx);
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
