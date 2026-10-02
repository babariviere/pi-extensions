/** Standalone child-session runners. Pi owns native codemode, discovery and execution. */
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionShutdownEvent,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { actionContext, createActionTool } from "../shared/action-tools.ts";
import { readExtensionConfig } from "../shared/config.ts";
import type { AgentCompletionEvent } from "./agent-run-book.ts";
import type { AgentRunRegistry } from "./agent-run-monitor.ts";
import { AgentsProvider, type SessionRef } from "./agents-provider.ts";
import type { DurableSupervisor } from "./durable-supervisor.ts";
import type { AgentRuns } from "./agent-runs.ts";
import { normalizeSubagentsConfig, DEFAULT_SUBAGENTS_CONFIG } from "./config.ts";
import { isChildSession } from "./constants.ts";
import { formatElapsed } from "./progress.ts";
import { inheritedParentModel } from "./parent-model.ts";
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

export interface SubagentExtensionDeps {
	/** Offline lifecycle tests can supply a runner without launching Pi. */
	acquireDurableSupervisor?: (ref: SessionRef) => Promise<DurableSupervisor>;
}

export default function subagents(pi: ExtensionAPI, deps: SubagentExtensionDeps = {}): void {
	registerTaskFileFlag(pi);
	pi.registerFlag("no-subagents-progress", {
		type: "boolean",
		default: false,
		description: "Disable the compact subagent progress widget in interactive sessions.",
	});
	const deliverTask = taskDeliveryFor(pi);
	let context: ExtensionContext | undefined;
	let provider: AgentsProvider | undefined;
	let durable: DurableSupervisor | undefined;
	let closeDurable: ((preserveRuns?: boolean) => Promise<void>) | undefined;
	let config = DEFAULT_SUBAGENTS_CONFIG;
	let generation = 0;
	let unsubscribe: (() => void) | undefined;
	let widgetRefresh: ReturnType<typeof setTimeout> | undefined;
	let widgetTick: ReturnType<typeof setInterval> | undefined;
	let closing: Promise<void> | undefined;
	const calls = new Map<string, number>();
	const tools = new Map<string, ToolDefinition<any, any>>();

	function shutdown(reason?: SessionShutdownEvent["reason"]): Promise<void> {
		if (closing) return closing;
		generation++;
		const old = provider;
		provider = undefined;
		const supervisor = durable;
		durable = undefined;
		const release = closeDurable;
		closeDurable = undefined;
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
		const preserveRuns = reason === "reload" && supervisor !== undefined;
		const pending = (async () => {
			try {
				// The durable owner drains once below. Disconnect the provider now
				// without adding a second five-second drain on normal shutdown.
				await old?.close({ preserveRuns: supervisor !== undefined });
			} finally {
				if (preserveRuns) await supervisor?.suspend();
				else await release?.(reason === "quit");
			}
		})();
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
		const ref: SessionRef = {
			cwd: ctx.cwd,
			sessionId: ctx.sessionManager.getSessionId() || undefined,
			sessionFile: ctx.sessionManager.getSessionFile() || undefined,
			projectTrusted: ctx.isProjectTrusted(),
		};
		let registry: AgentRunRegistry;
		let book: AgentRuns;
		{
			const module = await import("./durable-supervisor.ts");
			const supervisor = await (deps.acquireDurableSupervisor ?? module.acquireDurableSupervisor)(ref);
			if (current !== generation) {
				await module.closeDurableSupervisor(ref);
				return;
			}
			durable = supervisor;
			closeDurable = (preserveRuns) => module.closeDurableSupervisor(ref, { preserveRuns });
			supervisor.setErrorHandler((error) => context?.ui.notify(`Subagents storage: ${String(error)}`, "error"));
			registry = supervisor.registry;
			book = supervisor.book;
		}
		book.setAnnounceWhen(() => current === generation && !!context?.isIdle());
		book.setSink((result) => announce(pi, result));
		const active = new AgentsProvider(
			() => ({
				...ref,
				cwd: context?.cwd ?? ref.cwd,
				projectTrusted: context?.isProjectTrusted() ?? ref.projectTrusted,
			}),
			registry,
			() => {
				if (!context) throw new Error("Subagents session is not initialized");
				const parentModel = inheritedParentModel(context);
				return {
					timeoutMs: config.timeoutMs,
					waitMs: config.waitMs,
					parentProvider: parentModel?.provider,
					defaultModel:
						config.defaultModel ?? (parentModel ? `${parentModel.provider}/${parentModel.id}` : undefined),
					defaultThinking: config.defaultThinking,
					models,
				};
			},
			book,
			durable?.launcher,
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
	pi.on("agent_settled", async () => {
		await provider?.runs.flushCompletions();
	});
	pi.on("session_shutdown", async (event) => {
		deliverTask.cancel();
		await shutdown(event.reason);
	});
}
