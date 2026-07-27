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
import {
  SpindleAgentsProvider,
  type SessionRef,
} from "./providers/agents-provider.ts";
import { CapturedToolsProvider } from "./providers/captured-tools-provider.ts";
import { McpBridgeProvider } from "./providers/mcp-bridge-provider.ts";
import { PiToolsProvider } from "./providers/pi-tools-provider.ts";
import {
  SPINDLE_PROVIDER_DISCOVER_EVENT,
  type SpindleProvider,
  type SpindleProviderDiscovery,
} from "./protocol.ts";

const RESERVED_PROVIDER_NAMES = ["pi", "mcp", "agents", "extensions", "spindle"];

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
  readonly #externalProviders = new Map<string, SpindleProvider>();
  readonly activity = new SpindleActivityStore();
  readonly agentRuns = new SpindleAgentRunRegistry();
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
    this.#registry = new ActionRegistry(
      new SpindleToolResultProxy(() => this.capturedTools.runner),
    );
    const capturedToolsProvider =
      this.#config.fullCodeMode && this.#config.capture.enabled
        ? new CapturedToolsProvider(this.capturedTools, this.#gate)
        : undefined;
    if (this.#config.fullCodeMode) {
      this.#registry.register(
        new PiToolsProvider(
          context.cwd,
          this.capturedTools,
          capturedToolsProvider,
          this.#gate,
        ),
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
          ...(this.config.agents.defaultModel
            ? { defaultModel: this.config.agents.defaultModel }
            : {}),
          ...(this.config.agents.defaultThinking
            ? { defaultThinking: this.config.agents.defaultThinking }
            : {}),
        }),
      ),
    );
    for (const provider of this.#externalProviders.values()) {
      this.#registry.register(provider);
    }
    this.#execution = new SpindleExecutionService(
      this.#registry,
      this.#config,
      this.activity,
      undefined,
      this.#gate,
    );
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
    deepAssign(
      this.#config as unknown as Record<string, unknown>,
      next as unknown as Record<string, unknown>,
    );
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

  async #closeInternal(): Promise<void> {
    if (!this.#registry) return;
    const externalNames = new Set(this.#externalProviders.keys());
    await this.#registry.close(externalNames);
    this.#registry = undefined;
    this.#execution = undefined;
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const deepAssign = (
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): void => {
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
