/** One native tool for reusable named background conversations. */
import { Type } from "@earendil-works/pi-ai";
import type { JsonValue } from "@earendil-works/chord";
import {
	truncateHead,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionShutdownEvent,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { readExtensionConfig } from "../shared/config.ts";
import { DEFAULT_SUBAGENTS_CONFIG, normalizeSubagentsConfig } from "./config.ts";
import { isChildSession } from "./constants.ts";
import { inheritedParentModel } from "./parent-model.ts";
import {
	acquireDurableSupervisor,
	closeDurableSupervisor,
	type DurableSupervisor,
	type SubagentReport,
} from "./durable-supervisor.ts";
import type { SessionRef } from "./session-ref.ts";
import {
	SUBAGENTS_COMMAND_EVENT,
	SUBAGENTS_COMMAND_RESULT_EVENT,
	SUBAGENTS_REQUEST_SNAPSHOT_EVENT,
	SUBAGENTS_SNAPSHOT_EVENT,
	type SubagentHostCommand,
	type SubagentHostCommandResult,
	type SubagentHostSnapshot,
} from "./host-events.ts";

export const SubagentParameters = Type.Object(
	{
		action: Type.Union([Type.Literal("spawn"), Type.Literal("send"), Type.Literal("stop"), Type.Literal("status")]),
		name: Type.Optional(Type.String()),
		message: Type.Optional(Type.String()),
		followUp: Type.Optional(Type.Boolean()),
		cwd: Type.Optional(
			Type.String({
				description:
					"Spawn only. Existing directory, relative to the parent cwd or absolute. Defaults to the parent cwd. Fixed for sends and recovery; unavailable during night runs.",
			}),
		),
	},
	{ additionalProperties: false },
);

export interface SubagentExtensionDeps {
	acquireDurableSupervisor?: (ref: SessionRef) => Promise<DurableSupervisor>;
	closeDurableSupervisor?: typeof closeDurableSupervisor;
}

function announce(pi: ExtensionAPI, report: SubagentReport): void {
	const preview = truncateHead(report.text);
	pi.sendMessage(
		{
			customType: "subagent.result",
			display: true,
			content: `[subagent ${JSON.stringify(report.name)} ${report.error ? "failed" : "answered"}, no reply needed] ${preview.content}${preview.truncated ? "\n[Truncated. Use subagent status with this name for the completed answer.]" : ""}`,
			details: { name: report.name, conversationId: report.conversationId, answerId: report.answerId },
		},
		{ deliverAs: "followUp", triggerTurn: true },
	);
}

const validName = (name: unknown): string => {
	if (typeof name !== "string" || !name.trim() || name.length > 128 || /[\x00-\x1f\x7f]/.test(name))
		throw new Error("subagent requires a non-empty name of at most 128 characters without control characters");
	return name.trim();
};

export default function subagents(pi: ExtensionAPI, deps: SubagentExtensionDeps = {}): void {
	pi.registerFlag("no-subagents-progress", {
		type: "boolean",
		default: false,
		description: "Disable the compact subagent progress widget.",
	});
	let context: ExtensionContext | undefined;
	let ref: SessionRef | undefined;
	let supervisor: DurableSupervisor | undefined;
	let config = DEFAULT_SUBAGENTS_CONFIG;
	let generation = 0;
	let closing: Promise<void> | undefined;
	let unsubscribe: (() => void) | undefined;
	let hostEvents: Array<() => void> = [];
	let widgetRefresh: ReturnType<typeof setTimeout> | undefined;
	let definition: ToolDefinition<typeof SubagentParameters> | undefined;
	const calls = new Map<string, number>();
	function shutdown(reason?: SessionShutdownEvent["reason"]): Promise<void> {
		if (closing) return closing;
		generation++;
		const previous = supervisor;
		const previousRef = ref;
		supervisor = undefined;
		ref = undefined;
		context?.ui.setWidget("subagents-progress", undefined);
		context = undefined;
		unsubscribe?.();
		unsubscribe = undefined;
		for (const off of hostEvents) off();
		hostEvents = [];
		if (widgetRefresh) clearTimeout(widgetRefresh);
		widgetRefresh = undefined;
		calls.clear();
		if (definition) pi.registerTool({ ...definition, exposure: "hidden" });
		definition = undefined;
		previous?.suspend();
		const pending = (async () => {
			if (reason !== "reload" && previousRef)
				await (deps.closeDurableSupervisor ?? closeDurableSupervisor)(previousRef, {
					preserveRuns: reason === "quit",
				});
		})();
		closing = pending;
		void pending
			.finally(() => {
				if (closing === pending) closing = undefined;
			})
			.catch(() => {});
		return pending;
	}
	pi.on("session_start", async (_event, ctx) => {
		await shutdown();
		const current = ++generation;
		context = ctx;
		if (isChildSession()) return;
		config = normalizeSubagentsConfig(readExtensionConfig("subagents.json", ctx));
		const models = ctx.scopedModels.length
			? ctx.scopedModels.map((entry) => entry.model)
			: await ctx.modelRegistry.getAvailable();
		if (current !== generation) return;
		const parentRef: SessionRef = {
			cwd: ctx.cwd,
			sessionId: ctx.sessionManager.getSessionId() || undefined,
			sessionFile: ctx.sessionManager.getSessionFile() || undefined,
			projectTrusted: ctx.isProjectTrusted(),
		};
		const owner = await (deps.acquireDurableSupervisor ?? acquireDurableSupervisor)(parentRef);
		if (current !== generation) {
			await (deps.closeDurableSupervisor ?? closeDurableSupervisor)(parentRef);
			return;
		}
		ref = parentRef;
		supervisor = owner;
		owner.setErrorHandler((error) => context?.ui.notify(`Subagents: ${String(error)}`, "error"));
		owner.setSink(
			(report) => announce(pi, report),
			() => current === generation && !!context?.isIdle(),
		);
		definition = {
			name: "subagent",
			label: "Subagent",
			exposure: "codemode",
			description:
				"Manage persistent background subagents. spawn needs name and message and accepts an optional cwd (relative to the parent or absolute, fixed for this conversation); send needs name and message and steers unless followUp is true; stop aborts current/queued work but keeps the conversation usable; status takes a name for its latest completed answer and acknowledges that answer's pending notification, or no name for compact summaries. Unread answers arrive automatically. Names identify conversations, not Markdown agent definitions. Model/thinking and lifetime are host policy. Night runs inherit the active host contract, control placement and reject cwd; use ordinary conversation names. Children cannot launch subagents or jobs.",
			parameters: SubagentParameters,
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
			execute: async (callId, args, signal) => {
				if (current !== generation || supervisor !== owner) throw new Error("Subagents session is not initialized");
				signal?.throwIfAborted();
				if (!["spawn", "send", "stop", "status"].includes(args.action)) throw new Error("Unknown subagent action");
				if (args.cwd !== undefined && args.action !== "spawn") throw new Error("cwd is only supported for spawn");
				let result: unknown;
				let text: string;
				if (args.action === "status" && args.name === undefined) {
					const agents = owner.list();
					result = { agents };
					text = agents.length
						? agents.map((agent) => `${agent.name}: ${agent.state}`).join("\n")
						: "No subagents.";
				} else {
					const name = validName(args.name);
					if (args.action === "status") {
						result = await owner.status(name);
						text = JSON.stringify(result);
					} else if (args.action === "stop") {
						result = await owner.stop(name);
						text = `Stopped ${name}.`;
					} else {
						if (typeof args.message !== "string" || !args.message.trim())
							throw new Error(`${args.action} needs a non-empty message.`);
						if (args.action === "spawn") {
							if (!context) throw new Error("Subagents session is not initialized");
							const parent = inheritedParentModel(context);
							result = await owner.spawn(
								name,
								args.message,
								callId,
								{
									model: config.defaultModel ?? (parent ? `${parent.provider}/${parent.id}` : undefined),
									thinking: config.defaultThinking,
									parentProvider: parent?.provider,
									models,
									timeoutMs: config.timeoutMs,
								},
								args.cwd,
							);
							text = `Started ${name}.`;
						} else {
							result = await owner.send(name, args.message, args.followUp === true, callId);
							text = `Sent to ${name}.`;
						}
					}
				}
				return {
					content: [{ type: "text", text }],
					details: result,
					structuredContent: JSON.parse(JSON.stringify(result)) as JsonValue,
				};
			},
		};
		pi.registerTool(definition!);
		const publish = () => {
			if (current !== generation || supervisor !== owner) return;
			const snapshot: SubagentHostSnapshot = { agents: owner.describe() };
			pi.events.emit(SUBAGENTS_SNAPSHOT_EVENT, snapshot);
		};
		const answer = (result: SubagentHostCommandResult) => pi.events.emit(SUBAGENTS_COMMAND_RESULT_EVENT, result);
		hostEvents.push(
			pi.events.on(SUBAGENTS_REQUEST_SNAPSHOT_EVENT, publish),
			pi.events.on(SUBAGENTS_COMMAND_EVENT, async (data) => {
				const command = data as SubagentHostCommand | undefined;
				if (!command || typeof command.requestId !== "string" || !command.requestId) return;
				try {
					if (current !== generation || supervisor !== owner)
						throw new Error("Subagents session is not initialized");
					const name = validName(command.name);
					if (command.action === "stop") await owner.stop(name);
					else if (command.action === "send") {
						if (typeof command.message !== "string" || !command.message.trim())
							throw new Error("send needs a non-empty message.");
						// Stable input ID: a retried host request is admitted once.
						await owner.send(name, command.message, command.followUp === true, `host:${command.requestId}`);
					} else throw new Error("Unknown subagent command");
					answer({ requestId: command.requestId, ok: true });
				} catch (error) {
					answer({
						requestId: command.requestId,
						ok: false,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}),
		);
		const widget = ctx.mode === "tui" && ctx.hasUI && pi.getFlag("no-subagents-progress") !== true;
		const refresh = () => {
			if (widget) {
				const active = owner.list().filter((agent) => agent.state === "working");
				context?.ui.setWidget(
					"subagents-progress",
					active.length
						? [
								`Subagents (${active.length}): ${active
									.slice(0, 3)
									.map((agent) => agent.name)
									.join(", ")}${active.length > 3 ? ", …" : ""}`,
							]
						: undefined,
				);
			}
			publish();
		};
		unsubscribe = owner.subscribe(() => {
			if (!widgetRefresh) {
				widgetRefresh = setTimeout(() => {
					widgetRefresh = undefined;
					refresh();
				}, 250);
				widgetRefresh.unref();
			}
		});
		refresh();
	});
	pi.on("before_agent_start", (_event, ctx) => {
		context = ctx;
	});
	pi.on("tool_call", (event) => {
		if (event.toolName !== "subagent") return;
		if (!supervisor) return { block: true, reason: "Subagents session is not initialized" };
		if (event.input.action !== "spawn") return;
		const id = event.parentToolCallId ?? event.toolCallId;
		const count = (calls.get(id) ?? 0) + 1;
		calls.set(id, count);
		if (count > config.maxPerExecution) return { block: true, reason: "Subagent spawn-call budget exceeded" };
	});
	pi.on("tool_execution_end", (event) => {
		calls.delete(event.toolCallId);
	});
	pi.on("agent_settled", async () => {
		await supervisor?.flushReports();
	});
	pi.on("session_shutdown", async (event) => {
		await shutdown(event.reason);
	});
}
