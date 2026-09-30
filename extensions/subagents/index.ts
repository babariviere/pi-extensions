/** Standalone child-session runners. Pi owns native codemode, discovery and execution. */
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { actionContext, createActionTool } from "../shared/action-tools.ts";
import { readExtensionConfig } from "../shared/config.ts";
import { AgentRunBook, type AgentCompletionEvent } from "./agent-run-book.ts";
import { AgentRunRegistry } from "./agent-run-monitor.ts";
import { AgentsProvider } from "./agents-provider.ts";
import { normalizeSubagentsConfig, DEFAULT_SUBAGENTS_CONFIG } from "./config.ts";
import { isChildSession } from "./constants.ts";
import { formatElapsed } from "./progress.ts";
import { registerTaskFileFlag, taskDeliveryFor } from "./task-delivery.ts";

function announce(pi: ExtensionAPI, event: AgentCompletionEvent): void {
	const body = event.results
		.map(
			(result) =>
				`## ${result.agent} (${result.ok ? "ok" : "failed"})${result.outputPath ? `\nResult file: ${result.outputPath}` : ""}\n\n${result.output}`,
		)
		.join("\n\n");
	const preview = truncateHead(body);
	pi.sendMessage(
		{
			customType: "subagents.result",
			content: `Subagent batch ${event.runId} finished after ${formatElapsed(event.elapsedMs)} (${event.agents.join(", ")}).\n\n${preview.content}${preview.truncated ? "\n[Preview truncated. Use agents_wait to retrieve structured results.]" : ""}`,
			display: true,
			details: {
				runId: event.runId,
				agents: event.agents,
				elapsedMs: event.elapsedMs,
				runs: event.results.map(({ agent, ok, state, outputPath, error }) => ({
					agent,
					ok,
					state,
					outputPath,
					error,
				})),
			},
		},
		{ deliverAs: "followUp", triggerTurn: true },
	);
}

export default function subagents(pi: ExtensionAPI): void {
	registerTaskFileFlag(pi);
	pi.registerFlag("no-subagents-progress", {
		type: "boolean",
		default: false,
		description: "Disable the compact subagent progress widget in interactive sessions.",
	});
	const deliverTask = taskDeliveryFor(pi);
	let context: ExtensionContext | undefined;
	let provider: AgentsProvider | undefined;
	let config = DEFAULT_SUBAGENTS_CONFIG;
	let generation = 0;
	let unsubscribe: (() => void) | undefined;
	let widgetRefresh: ReturnType<typeof setTimeout> | undefined;
	let widgetTick: ReturnType<typeof setInterval> | undefined;
	let closing: Promise<void> | undefined;
	const calls = new Map<string, number>();
	const tools = new Map<string, ToolDefinition<any, any>>();

	function shutdown(): Promise<void> {
		if (closing) return closing;
		generation++;
		const old = provider;
		provider = undefined;
		const previous = context;
		context = undefined;
		unsubscribe?.();
		unsubscribe = undefined;
		if (widgetRefresh) clearTimeout(widgetRefresh);
		widgetRefresh = undefined;
		if (widgetTick) clearInterval(widgetTick);
		widgetTick = undefined;
		calls.clear();
		previous?.ui.setWidget("subagents-progress", undefined);
		for (const definition of tools.values()) pi.registerTool({ ...definition, exposure: "hidden" });
		tools.clear();
		const pending = old?.close() ?? Promise.resolve();
		closing = pending;
		void pending
			.finally(() => {
				if (closing === pending) closing = undefined;
			})
			.catch(() => {});
		return pending;
	}

	pi.on("session_start", async (event, ctx) => {
		await shutdown();
		const current = ++generation;
		context = ctx;
		if (event.reason !== "startup") deliverTask.cancel();
		deliverTask(event.reason);
		if (isChildSession()) return;
		config = normalizeSubagentsConfig(readExtensionConfig("subagents.json", ctx));
		const models = ctx.scopedModels.length
			? ctx.scopedModels.map((entry) => entry.model)
			: await ctx.modelRegistry.getAvailable();
		if (current !== generation) return;
		const registry = new AgentRunRegistry();
		const book = new AgentRunBook();
		book.setAnnounceWhen(() => current === generation && !!context?.isIdle());
		book.setSink((result) => announce(pi, result));
		const active = new AgentsProvider(
			() => ({
				cwd: context?.cwd ?? ctx.cwd,
				sessionId: ctx.sessionManager.getSessionId() || undefined,
				sessionFile: ctx.sessionManager.getSessionFile() || undefined,
				projectTrusted: ctx.isProjectTrusted(),
			}),
			registry,
			() => ({
				timeoutMs: config.timeoutMs,
				waitMs: config.waitMs,
				parentProvider: context?.model?.provider,
				defaultModel:
					config.defaultModel ?? (context?.model ? `${context.model.provider}/${context.model.id}` : undefined),
				defaultThinking: config.defaultThinking,
				models,
			}),
			book,
		);
		provider = active;
		if (ctx.mode === "tui" && ctx.hasUI && pi.getFlag("no-subagents-progress") !== true) {
			const refresh = () => {
				const rows = registry.list().filter((row) => row.status === "queued" || row.status === "running");
				const line = `Subagents (${rows.length}): ${rows
					.slice(0, 3)
					.map(
						(row) =>
							`${row.name.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 40)} ${row.status} ${formatElapsed(Date.now() - row.startedAt)}`,
					)
					.join(" · ")}${rows.length > 3 ? " · …" : ""}`;
				ctx.ui.setWidget(
					"subagents-progress",
					rows.length
						? () => ({
								render: (width) => [truncateToWidth(line, width)],
								invalidate() {},
							})
						: undefined,
				);
			};
			unsubscribe = registry.subscribe(() => {
				if (!widgetRefresh) {
					widgetRefresh = setTimeout(() => {
						widgetRefresh = undefined;
						refresh();
					}, 250);
					widgetRefresh.unref?.();
				}
			});
			widgetTick = setInterval(refresh, 1_000);
			widgetTick.unref?.();
		}
		for (const descriptor of await active.list({}, actionContext(ctx, "subagents-startup"))) {
			if (current !== generation) return;
			const definition = createActionTool(active, descriptor);
			tools.set(definition.name, definition);
			pi.registerTool(definition);
		}
	});
	pi.on("before_agent_start", (_event, ctx) => {
		context = ctx;
	});
	pi.on("tool_call", (event) => {
		if (!["agents_run", "agents_runAll", "agents_start"].includes(event.toolName)) return;
		if (!provider) return { block: true, reason: "Subagents session is not initialized" };
		const id = event.parentToolCallId ?? event.toolCallId;
		const count = (calls.get(id) ?? 0) + 1;
		calls.set(id, count);
		if (count > config.maxPerExecution) return { block: true, reason: "Subagent launch-call budget exceeded" };
	});
	pi.on("tool_execution_end", (event) => {
		calls.delete(event.toolCallId);
	});
	pi.on("agent_settled", () => {
		provider?.runs.flushCompletions();
	});
	pi.on("session_shutdown", async () => {
		deliverTask.cancel();
		await shutdown();
	});
}
