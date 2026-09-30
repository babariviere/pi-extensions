/** Filesystem and read-only MCP policy for native Pi tools, independent of codemode. */
import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { applyNightRunEnv } from "../night-mode/night-run.ts";
import { parseApplyPatch } from "../apply-patch/apply-patch-parser.ts";
import { readExtensionConfig } from "../shared/config.ts";
import { agentSandboxFloor } from "./agent-floor.ts";
import { SandboxController, type SandboxSource } from "./controller.ts";
import { activeNightSandboxRequest } from "./night-bridge.ts";
import { activeNightMcpReadOnly } from "./night-mcp.ts";
import {
	effectiveMcpReadOnlyConfig,
	McpReadOnlyGate,
	normalizeMcpReadOnlyConfig,
	type McpReadOnlyConfig,
} from "./mcp-policy.ts";
import { assertNativeReadPath, createNativeSandboxTools, NATIVE_SANDBOX_TOOL_NAMES } from "./native-tools.ts";
import { isSandboxMode, policyEnvironment, resolveSandboxPolicy, SANDBOX_MODES, type SandboxPolicy } from "./policy.ts";
import {
	parseSandboxRequestEvent,
	SANDBOX_REQUEST_EVENT,
	SANDBOX_STATE_EVENT,
	type SandboxRequest,
	type SandboxStateEvent,
} from "./protocol.ts";
import { effectiveSandbox, type SandboxSettings } from "./resolve.ts";
import { runNightPreflight } from "./preflight-bridge.ts";
import {
	SANDBOX_WRAP_COMMAND_EVENT,
	SANDBOX_WRITE_GUARD_EVENT,
	type WrapCommandRequest,
	type WriteGuardRequest,
} from "./service.ts";

function strings(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === "string" && !!entry.trim())
		: [];
}
function settings(ctx: ExtensionContext): { filesystem: SandboxSettings; mcp: McpReadOnlyConfig } {
	const value = readExtensionConfig("sandbox.json", ctx);
	return {
		filesystem: {
			mode: isSandboxMode(value.mode) ? value.mode : "off",
			allowWrite: strings(value.allowWrite),
			denyWrite: strings(value.denyWrite),
			denyRead: strings(value.denyRead),
		},
		mcp: normalizeMcpReadOnlyConfig(value.mcp),
	};
}

/** Server hints may tighten our policy, never grant an unclassified MCP mutation. */
export function assertNativeMcpCall(config: McpReadOnlyConfig, info: ToolInfo, args: Record<string, unknown>): void {
	const namespace = info.namespace?.name;
	const serverName = namespace?.startsWith("mcp__") ? namespace.slice(5) : undefined;
	const prefix = serverName ? `mcp__${serverName}__` : undefined;
	const match =
		prefix && info.name.startsWith(prefix)
			? [info.name, serverName, info.name.slice(prefix.length)]
			: /^mcp__([A-Za-z0-9_-]+?)__(.+)$/.exec(info.name);
	if (!match) return;
	const [, server, tool] = match;
	const gate = McpReadOnlyGate.of(config);
	gate.assert(tool!, server, args);
	const decision = gate.decide(tool!, server, args);
	if (
		gate.readOnly &&
		["unknown-tool", "read-shape"].includes(decision.rule) &&
		(info.annotations?.destructiveHint === true || info.annotations?.readOnlyHint === false)
	) {
		throw new Error(
			`MCP call ${server}.${tool} is refused: read-only policy and server hints disagree. Review sandbox.json permissions.`,
		);
	}
}

export class SandboxSession {
	#context: ExtensionContext | undefined;
	#settings: ReturnType<typeof settings> | undefined;
	#controller: SandboxController | undefined;
	#request: SandboxRequest | undefined;
	#floor: SandboxRequest | undefined;
	#ref: { cwd: string; sessionId?: string } = { cwd: process.cwd() };
	#tail: Promise<unknown> = Promise.resolve();
	#generation = 0;
	readonly #owned = new Map<string, string>();
	readonly #unsubscribes: (() => void)[] = [];

	constructor(readonly pi: ExtensionAPI) {
		pi.on("tool_call", async (event, ctx) => {
			try {
				await this.refresh(ctx);
				const controller = this.current();
				const info = pi.getAllTools().find((tool) => tool.name === event.toolName);
				if ((NATIVE_SANDBOX_TOOL_NAMES as readonly string[]).includes(event.toolName)) {
					if (controller.enforcing && (!info || this.#owned.get(event.toolName) !== info.sourceInfo.path))
						throw new Error(`sandbox: ${event.toolName} has a sibling override; refusing unchecked execution`);
					if (["read", "grep", "find", "ls"].includes(event.toolName))
						assertNativeReadPath(controller, event.toolName, event.input, ctx.cwd);
				}
				if (event.toolName === "applyPatch" && controller.enforcing) {
					const patch = (event.input as Record<string, unknown>).patch;
					if (typeof patch !== "string") throw new Error("sandbox: applyPatch requires a V4A patch");
					for (const action of parseApplyPatch(patch)) {
						controller.writeGuard()(resolve(ctx.cwd, action.path));
						if (action.kind === "update" && action.moveTo)
							controller.writeGuard()(resolve(ctx.cwd, action.moveTo));
					}
				}
				if (event.toolName === "powershell" && controller.enforcing)
					throw new Error("sandbox: powershell is not supported by the OS adapter; use bash");
				if (event.toolName.startsWith("mcp__")) {
					if (!info) throw new Error("sandbox: MCP tool is absent from the registered catalog");
					assertNativeMcpCall(
						effectiveMcpReadOnlyConfig(this.#settings!.mcp, activeNightMcpReadOnly(this.#ref)),
						info,
						event.input,
					);
				}
			} catch (error) {
				return { block: true, reason: error instanceof Error ? error.message : String(error) };
			}
		});
		pi.registerCommand("sandbox", {
			description: "Filesystem sandbox (status | off | read-only | workspace-write | full [extra writable paths])",
			getArgumentCompletions: (prefix) =>
				["status", ...SANDBOX_MODES]
					.filter((mode) => mode.startsWith(prefix))
					.map((value) => ({ value, label: value })),
			handler: async (args, ctx) => {
				const [mode, ...allowWrite] = args.trim().split(/\s+/).filter(Boolean);
				if (!mode || mode === "status") {
					ctx.ui.notify(this.current().describe(), "info");
					return;
				}
				if (!isSandboxMode(mode)) {
					ctx.ui.notify(`Unknown sandbox mode '${mode}'`, "error");
					return;
				}
				await this.apply(mode === "off" ? null : { mode, allowWrite }, ctx, "requested via /sandbox");
			},
		});
	}

	/** Test seam, so unit tests never start an actual OS sandbox. */
	protected createController(policy: SandboxPolicy, source: SandboxSource): SandboxController {
		return new SandboxController(policy, source);
	}
	current(): SandboxController {
		if (!this.#context || !this.#controller) throw new Error("Sandbox session is not initialized");
		return this.#controller;
	}
	resolve() {
		if (!this.#settings) throw new Error("Sandbox session is not initialized");
		applyNightRunEnv(this.#ref);
		const effective = effectiveSandbox({
			settings: this.#settings.filesystem,
			requested: this.#request,
			night: activeNightSandboxRequest(this.#ref),
			agent: this.#floor,
		});
		return { effective, policy: resolveSandboxPolicy(effective, policyEnvironment(this.#ref.cwd)) };
	}
	async initialize(ctx: ExtensionContext): Promise<void> {
		await this.close();
		const generation = ++this.#generation;
		this.#context = ctx;
		this.#settings = settings(ctx);
		this.#floor = agentSandboxFloor();
		this.#ref = { cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() || undefined };
		const { policy, effective } = this.resolve();
		this.#controller = this.createController(policy, effective.source === "config" ? "config" : "request");
		const applied = this.#controller.apply(policy, effective.source === "config" ? "config" : "request");
		this.#tail = applied.catch(() => {});
		await applied;
		if (generation !== this.#generation) return;
		const hostSettings = this.pi.getSettings();
		for (const definition of createNativeSandboxTools(ctx.cwd, () => this.current(), {
			bash: { shellPath: hostSettings.shellPath, commandPrefix: hostSettings.shellCommandPrefix },
			read: { autoResizeImages: hostSettings.images?.autoResize },
		})) {
			const existing = this.pi.getAllTools().find((tool) => tool.name === definition.name);
			if (
				!existing ||
				(existing.sourceInfo.path !== `builtin:${definition.name}` &&
					this.#owned.get(definition.name) !== existing.sourceInfo.path)
			)
				continue;
			this.pi.registerTool(definition);
			const owner = this.pi.getAllTools().find((tool) => tool.name === definition.name);
			if (owner && owner.sourceInfo.path !== `builtin:${definition.name}`)
				this.#owned.set(definition.name, owner.sourceInfo.path);
		}
		this.publish(ctx);
		this.#unsubscribes.push(
			this.pi.events.on(SANDBOX_REQUEST_EVENT, (value) => {
				const request = parseSandboxRequestEvent(value);
				if (request)
					void this.apply(request.policy, ctx, request.reason).catch((error) => {
						if (generation === this.#generation)
							ctx.ui.notify(`Sandbox request failed: ${String(error)}`, "error");
					});
			}),
		);
		this.#unsubscribes.push(
			this.pi.events.on(SANDBOX_WRITE_GUARD_EVENT, (value) => {
				const request = value as WriteGuardRequest;
				try {
					this.current().writeGuard()(request.path);
				} catch (error) {
					request.error = error instanceof Error ? error : new Error(String(error));
				}
			}),
		);
		this.#unsubscribes.push(
			this.pi.events.on(SANDBOX_WRAP_COMMAND_EVENT, (value) => {
				const request = value as WrapCommandRequest;
				request.result = this.refresh(ctx).then(() => this.current().wrapCommand(request.command));
			}),
		);
	}
	async refresh(ctx: ExtensionContext): Promise<void> {
		await this.#tail;
		const { policy } = this.resolve();
		if (JSON.stringify(policy) !== JSON.stringify(this.current().policy))
			await this.apply(this.#request ?? null, ctx);
	}
	apply(
		request: SandboxRequest | null,
		ctx: ExtensionContext,
		reason?: string,
	): Promise<SandboxStateEvent | undefined> {
		const generation = this.#generation;
		const controller = this.current();
		const applied = this.#tail.then(async () => {
			if (generation !== this.#generation) return undefined;
			this.#request = request ?? undefined;
			const { policy, effective } = this.resolve();
			const state = await controller.apply(policy, effective.source === "config" ? "config" : "request");
			if (generation !== this.#generation) return undefined;
			this.publish(ctx);
			if (reason || effective.refused)
				ctx.ui.notify(
					`${controller.describe()}${effective.refused ? ` (${effective.source} floor refused '${effective.refused.asked}')` : ""}${reason ? ` (${reason})` : ""}`,
					effective.refused ? "warning" : "info",
				);
			void runNightPreflight({
				cwd: ctx.cwd,
				sessionId: this.#ref.sessionId,
				wrap: (command) => controller.wrapCommand(command),
			}).catch(() => {});
			return state;
		});
		this.#tail = applied.catch(() => {});
		return applied;
	}
	publish(ctx: ExtensionContext): void {
		const state = this.current().state();
		this.pi.events.emit(SANDBOX_STATE_EVENT, state);
		ctx.ui.setStatus(
			"sandbox",
			state.enforcing ? `🔒 ${state.mode}${state.osEnforced ? "" : " (bash refused)"}` : undefined,
		);
		if (state.degradedReason) ctx.ui.notify(this.current().describe(), "error");
		if (state.warnings?.length) ctx.ui.notify(state.warnings.join("; "), "warning");
	}
	async close(): Promise<void> {
		this.#generation++;
		const ctx = this.#context;
		this.#context = undefined;
		for (const unsubscribe of this.#unsubscribes.splice(0)) unsubscribe();
		await this.#tail;
		await this.#controller?.dispose();
		this.#controller = undefined;
		this.#settings = undefined;
		this.#request = undefined;
		this.#floor = undefined;
		ctx?.ui.setStatus("sandbox", undefined);
	}
}

export default function sandbox(pi: ExtensionAPI): void {
	const session = new SandboxSession(pi);
	pi.on("session_start", (_event, ctx) => session.initialize(ctx));
	pi.on("session_shutdown", () => session.close());
}
