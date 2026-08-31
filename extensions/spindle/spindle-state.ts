/**
 * LOCAL REWRITE of the upstream state module (see CONTEXT.md's rename mapping
 * for the upstream path).
 *
 * Upstream wired the actor manager, mesh store, lifecycle broker, control
 * plane, participant directory, prewalk controller, schema controller, state
 * store, compaction controller and its own agent manager. Spindle drops
 * all of them: this holds the config, the action registry, the four providers
 * (`pi`, `extensions`, `mcp`, `agents`), the execution service, the activity
 * store and the subagent run registry.
 */

import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SpindleActivityStore } from "./activity/store.ts";
import { CapturedToolCatalog } from "./capture/catalog.ts";
import { loadSpindleConfig, type SpindleConfig } from "./config.ts";
import { ActionRegistry } from "./core/action-registry.ts";
import { SpindleToolResultProxy } from "./core/tool-result-proxy.ts";
import { SpindleToolGate } from "./core/tool-allowlist.ts";
import { ALLOWED_TOOLS_FLAG } from "./agents/constants.ts";
import { SpindleExecutionService } from "./execution-service.ts";
import { SpindleAgentRunRegistry } from "./providers/agent-run-monitor.ts";
import { AgentRunBook, type AgentCompletionEvent } from "./providers/agent-run-book.ts";
import { SpindleAgentsProvider, type SessionRef } from "./providers/agents-provider.ts";
import { CapturedToolsProvider } from "./providers/captured-tools-provider.ts";
import { McpBridgeProvider } from "./providers/mcp-bridge-provider.ts";
import { PiToolsProvider } from "./providers/pi-tools-provider.ts";
import { SandboxController } from "./sandbox/controller.ts";
import { activeNightSandboxRequest } from "./sandbox/night-bridge.ts";
import { policyEnvironment, resolveSandboxPolicy } from "./sandbox/policy.ts";
import { effectiveSandbox } from "./sandbox/resolve.ts";
import {
	parseSandboxRequestEvent,
	SANDBOX_REQUEST_EVENT,
	SANDBOX_STATE_EVENT,
	type SandboxRequest,
	type SandboxStateEvent,
} from "./sandbox/protocol.ts";
import { SPINDLE_PROVIDER_DISCOVER_EVENT, type SpindleProvider, type SpindleProviderDiscovery } from "./protocol.ts";

const RESERVED_PROVIDER_NAMES = ["pi", "mcp", "agents", "extensions", "spindle"];

/** How long session teardown waits for cancelled subagent children to die. */
const AGENT_DRAIN_TIMEOUT_MS = 5_000;

export class SpindleState {
	#registry: ActionRegistry | undefined;
	#config: SpindleConfig | undefined;
	#execution: SpindleExecutionService | undefined;
	#cwd: string | undefined;
	/**
	 * Tool gate for this session, built from the parent's
	 * `--${ALLOWED_TOOLS_FLAG}` flag. Restricted only when this pi process is a
	 * Spindle subagent whose definition declared `tools:`; an unrestricted gate
	 * for a normal session.
	 */
	#gate: SpindleToolGate = SpindleToolGate.of(undefined);
	/** Filesystem guardrail for the mutating core tools; undefined until initialize(). */
	#sandbox: SandboxController | undefined;
	/** Unsubscribe for the mid-session sandbox request listener. */
	#unsubscribeSandbox: (() => void) | undefined;
	/**
	 * Last sandbox request from `/sandbox` or the bus. Cleared by a revert, so a
	 * request refused by an active night run does not resurface when the run ends.
	 */
	#sandboxRequest: SandboxRequest | undefined;
	readonly #externalProviders = new Map<string, SpindleProvider>();
	readonly activity = new SpindleActivityStore();
	readonly agentRuns = new SpindleAgentRunRegistry();
	/**
	 * Live subagent batches. Lives on the state (not the provider) because it
	 * outlives a single `spindle_exec` program: a detached run is cancelled at
	 * session teardown, and a result nobody claimed is injected back into this
	 * session through the completion sink below.
	 */
	readonly agentRunBook = new AgentRunBook();
	readonly #sessionRef: SessionRef = {
		sessionId: undefined,
		sessionFile: undefined,
		cwd: process.cwd(),
	};
	#widgetDismissedAt = 0;

	constructor(
		readonly pi: ExtensionAPI,
		readonly capturedTools: CapturedToolCatalog,
	) {}

	get initialized(): boolean {
		return Boolean(this.#execution);
	}

	get widgetDismissedAt(): number {
		return this.#widgetDismissedAt;
	}

	set widgetDismissedAt(value: number) {
		this.#widgetDismissedAt = value;
	}

	get cwd(): string | undefined {
		return this.#cwd;
	}

	/** The parent session the child agent runs are attributed to. */
	get sessionRef(): SessionRef {
		return this.#sessionRef;
	}

	get config(): SpindleConfig {
		if (!this.#config) throw new Error("Spindle has not initialized");
		return this.#config;
	}

	get registry(): ActionRegistry {
		if (!this.#registry) throw new Error("Spindle has not initialized");
		return this.#registry;
	}

	get execution(): SpindleExecutionService {
		if (!this.#execution) throw new Error("Spindle has not initialized");
		return this.#execution;
	}

	async initialize(context: ExtensionContext): Promise<void> {
		await this.#closeInternal();
		this.activity.reset();
		this.agentRuns.reset();
		this.#cwd = context.cwd;
		this.#gate = SpindleToolGate.fromArgv(ALLOWED_TOOLS_FLAG);
		// A new session must not inherit the previous one's children.
		this.agentRunBook.reset();
		this.agentRunBook.setSink((event) => this.#announceAgentCompletion(event));
		const projectTrusted = context.isProjectTrusted();
		this.#config = loadSpindleConfig({
			cwd: context.cwd,
			agentDir: getAgentDir(),
			projectTrusted,
		});
		this.#sessionRef.cwd = context.cwd;
		try {
			this.#sessionRef.sessionId = context.sessionManager.getSessionId() || undefined;
		} catch {
			this.#sessionRef.sessionId = undefined;
		}
		try {
			this.#sessionRef.sessionFile = context.sessionManager.getSessionFile() || undefined;
		} catch {
			this.#sessionRef.sessionFile = undefined;
		}
		this.#registry = new ActionRegistry(new SpindleToolResultProxy(() => this.capturedTools.runner));
		const capturedToolsProvider =
			this.#config.fullCodeMode && this.#config.capture.enabled
				? new CapturedToolsProvider(this.capturedTools, this.#gate)
				: undefined;
		if (this.#config.fullCodeMode) {
			this.#sandbox = await this.#createSandbox(context);
			const sandbox = this.#sandbox;
			this.#registry.register(
				new PiToolsProvider(context.cwd, this.capturedTools, capturedToolsProvider, this.#gate, {
					bash: sandbox.bashOperations(),
					wrapCommand: (command: string) => sandbox.wrapCommand(command),
					edit: sandbox.editOperations(),
					writeGuard: sandbox.writeGuard(),
					readGuard: sandbox.readGuard(),
				}),
			);
		}
		if (capturedToolsProvider) this.#registry.register(capturedToolsProvider);
		this.#registry.register(new McpBridgeProvider(() => this.capturedTools));
		this.#registry.register(
			new SpindleAgentsProvider(
				() => this.#sessionRef,
				this.agentRuns,
				() => ({
					timeoutMs: this.config.agents.timeoutMs,
					waitMs: this.config.agents.waitMs,
					...(this.config.agents.defaultModel ? { defaultModel: this.config.agents.defaultModel } : {}),
					...(this.config.agents.defaultThinking ? { defaultThinking: this.config.agents.defaultThinking } : {}),
				}),
				this.agentRunBook,
			),
		);
		for (const provider of this.#externalProviders.values()) {
			this.#registry.register(provider);
		}
		this.#execution = new SpindleExecutionService(this.#registry, this.#config, this.activity, this.#gate);
		const discovery: SpindleProviderDiscovery = {
			version: 1,
			register: (provider, options) => this.registerExternal(provider, options),
		};
		this.pi.events.emit(SPINDLE_PROVIDER_DISCOVER_EVENT, discovery);
	}

	async ensure(context: ExtensionContext): Promise<void> {
		if (!this.initialized || this.#cwd !== context.cwd) await this.initialize(context);
	}

	reloadConfig(context: ExtensionContext): void {
		if (!this.#config || !this.#cwd) return;
		const next = loadSpindleConfig({
			cwd: context.cwd,
			agentDir: getAgentDir(),
			projectTrusted: context.isProjectTrusted(),
		});
		deepAssign(this.#config as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>);
	}

	registerExternal(provider: SpindleProvider, options: { overwrite?: boolean } = {}): void {
		if (RESERVED_PROVIDER_NAMES.includes(provider.name)) {
			throw new Error(`Reserved Spindle provider name: ${provider.name}`);
		}
		if (this.#externalProviders.has(provider.name) && !options.overwrite) {
			throw new Error(`Spindle provider already registered: ${provider.name}`);
		}
		this.#externalProviders.set(provider.name, provider);
		if (this.#registry) this.#registry.register(provider, options);
	}

	async shutdown(): Promise<void> {
		// Cancelling the parent cancels its children, and waits for them: the kill
		// escalates SIGTERM -> SIGKILL on a timer, so exiting immediately would leave
		// a child that ignores SIGTERM behind as an orphan.
		this.agentRunBook.setSink(undefined);
		await this.agentRunBook.drain(AGENT_DRAIN_TIMEOUT_MS);
		await this.#registry?.close();
		this.#registry = undefined;
		this.#config = undefined;
		this.#execution = undefined;
		this.#cwd = undefined;
		this.#gate = SpindleToolGate.of(undefined);
		this.activity.reset();
		this.agentRuns.reset();
		this.#widgetDismissedAt = 0;
		this.#externalProviders.clear();
	}

	/**
	 * Resolve the effective policy from `spindle.json`, the last request, and the
	 * floor an active night run imposes (see `sandbox/resolve.ts`).
	 *
	 * The night policy is read from the handshake file rather than passed in, so a
	 * subagent process (which never sees the parent's event bus) inherits it just
	 * by starting up, and it survives a `/reload`.
	 */
	#resolveSandbox(cwd: string) {
		const effective = effectiveSandbox({
			settings: this.config.sandbox,
			requested: this.#sandboxRequest,
			// Session identity, so only participants of the run inherit its policy:
			// the handshake file is global, and a session opened mid-run is a bystander.
			night: activeNightSandboxRequest({ sessionId: this.#sessionRef.sessionId, cwd }),
		});
		const policy = resolveSandboxPolicy(
			{
				mode: effective.mode,
				allowWrite: effective.allowWrite,
				...(effective.denyWrite.length ? { denyWrite: effective.denyWrite } : {}),
				...(effective.denyRead.length ? { denyRead: effective.denyRead } : {}),
				network: effective.network,
			},
			policyEnvironment(cwd),
		);
		return { policy, effective };
	}

	/**
	 * Build the session's sandbox and subscribe to mid-session change requests.
	 * Never throws: an unsupported platform or a missing
	 * `@anthropic-ai/sandbox-runtime` install degrades to write/edit path guards,
	 * and the reason is surfaced to the user once.
	 */
	async #createSandbox(context: ExtensionContext): Promise<SandboxController> {
		const { policy, effective } = this.#resolveSandbox(context.cwd);
		const source = effective.source === "config" ? "config" : "request";
		const controller = new SandboxController(policy, source);
		const state = await controller.apply(policy, source);
		if (state.enforcing && state.degradedReason) {
			context.ui.notify(`spindle: ${controller.describe()}`, "warning");
		}
		this.pi.events.emit(SANDBOX_STATE_EVENT, state);

		// Another extension (night-mode) or the `/sandbox` command can change the
		// mode for the rest of the session. The operations installed on the tools
		// are late-bound, so the swap needs no re-registration.
		this.#unsubscribeSandbox = this.pi.events.on(SANDBOX_REQUEST_EVENT, (payload) => {
			const request = parseSandboxRequestEvent(payload);
			if (!request) return;
			void this.applySandboxRequest(request.policy, request.reason, context);
		});
		return controller;
	}

	/**
	 * Adopt a sandbox request. `null` reverts to `spindle.json`. An active night
	 * run acts as a floor: a request that would loosen it is refused and reported,
	 * so nothing can un-sandbox an unattended run mid-flight.
	 *
	 * Returns the resulting state, or undefined when there is no sandbox to change
	 * (Spindle not in full code mode).
	 */
	async applySandboxRequest(
		request: SandboxRequest | null,
		reason: string | undefined,
		context: ExtensionContext,
	): Promise<SandboxStateEvent | undefined> {
		const controller = this.#sandbox;
		if (!controller) return undefined;
		this.#sandboxRequest = request ?? undefined;
		const cwd = this.#cwd ?? context.cwd;
		const { policy, effective } = this.#resolveSandbox(cwd);
		const state = await controller.apply(policy, effective.source === "config" ? "config" : "request");
		this.pi.events.emit(SANDBOX_STATE_EVENT, state);
		if (effective.refused) {
			context.ui.notify(
				`spindle: '${effective.refused.asked}' refused, an active night run holds the sandbox at ` +
					`'${effective.refused.enforced}'. ${controller.describe()}`,
				"warning",
			);
			return state;
		}
		const suffix = reason ? ` (${reason})` : "";
		context.ui.notify(`spindle: ${controller.describe()}${suffix}`, "info");
		return state;
	}

	/** Current sandbox state, or undefined when there is no sandbox. */
	sandboxState(): SandboxStateEvent | undefined {
		return this.#sandbox?.state();
	}

	/** True while an active night run pins the sandbox. */
	sandboxHeldByNightRun(): boolean {
		return (
			activeNightSandboxRequest({
				sessionId: this.#sessionRef.sessionId,
				cwd: this.#cwd ?? this.#sessionRef.cwd,
			}) !== undefined
		);
	}

	/** One-line sandbox status, for `/sandbox` output. */
	sandboxStatus(): string {
		return this.#sandbox ? this.#sandbox.describe() : "sandbox off (no enforcement)";
	}

	/**
	 * Deliver a subagent result nobody was waiting for.
	 *
	 * A run whose wait window expired keeps going with no caller attached, so its
	 * result would otherwise land nowhere. Injecting it as a follow-up message
	 * wakes the parent with the outcome instead of requiring it to guess when to
	 * poll. Best-effort: a host that refuses the injection must not break the run
	 * book.
	 */
	#announceAgentCompletion(event: AgentCompletionEvent): void {
		const elapsed = `${Math.round(event.elapsedMs / 1000)}s`;
		const header = `Subagent batch ${event.runId} finished after ${elapsed} (${event.agents.join(", ")}).`;
		const body = event.results
			.map((result) => {
				const status = result.ok ? "ok" : `failed${result.error ? `: ${result.error}` : ""}`;
				const where = result.outputPath ? `\nresult file: ${result.outputPath}` : "";
				return `## ${result.agent} (${status})${where}\n\n${result.output}`;
			})
			.join("\n\n");
		try {
			this.pi.sendMessage(
				{
					customType: "spindle.agent_result",
					content: `${header}\n\n${body}`,
					display: true,
					// Outputs are already in `content`; the details carry the handles only,
					// so an announcement is not persisted twice.
					details: {
						runId: event.runId,
						agents: event.agents,
						elapsedMs: event.elapsedMs,
						runs: event.results.map((result) => ({
							agent: result.agent,
							ok: result.ok,
							state: result.state,
							...(result.outputPath ? { outputPath: result.outputPath } : {}),
							...(result.error ? { error: result.error } : {}),
						})),
					},
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		} catch {
			// No session to deliver into (shutting down, or a host without injection).
		}
	}

	async #closeInternal(): Promise<void> {
		this.#unsubscribeSandbox?.();
		this.#unsubscribeSandbox = undefined;
		const sandbox = this.#sandbox;
		this.#sandbox = undefined;
		if (sandbox) await sandbox.dispose();
		if (!this.#registry) return;
		const externalNames = new Set(this.#externalProviders.keys());
		await this.#registry.close(externalNames);
		this.#registry = undefined;
		this.#execution = undefined;
	}
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const deepAssign = (target: Record<string, unknown>, source: Record<string, unknown>): void => {
	for (const key of Object.keys(target)) {
		if (!(key in source)) delete target[key];
	}
	for (const [key, value] of Object.entries(source)) {
		const targetValue = target[key];
		if (isPlainObject(value) && isPlainObject(targetValue)) {
			deepAssign(targetValue, value);
		} else {
			target[key] = value;
		}
	}
};
