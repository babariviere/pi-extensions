/**
 * TRIMMED from upstream `src/config.ts`.
 *
 * The `mesh`, `memory`, `schema`, `compaction`, `retention`, `mcp` (upstream's
 * own embedded MCP client) and `prewalk` sections were removed with their
 * subsystems. `agents` is
 * repurposed for the absorbed subagents runner. `executor.runtime` is narrowed
 * to `"quickjs"` because the Node-process runtime is not vendored.
 *
 * The config file is `spindle.json`, NOT the upstream project's own config
 * file, so spindle never reads or writes upstream's user configuration.
 * See CONTEXT.md for the upstream name.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PI_CORE_TOOL_NAME_SET } from "./core/pi-tools.ts";
import {
  CURRENT_SPINDLE_CONFIG_VERSION,
  migrateSpindleConfigDocument,
} from "./config-migrations.ts";
import type { SpindleRisk } from "./protocol.ts";

type SpindleApprovalMode = "allow" | "ask" | "auto" | "deny";
export type SpindleUiWidgetMode = "auto" | "always" | "hidden";
export type SpindleResultFormat = "auto" | "yaml" | "json" | "text";
/** QuickJS is the only vendored runtime; the Node-process escape hatch is dropped. */
export type SpindleExecutorRuntime = "quickjs";

/** Thinking levels the absorbed subagents runner accepts (see agents/pi-args.ts). */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

interface SpindleExecutorConfig {
  runtime: SpindleExecutorRuntime;
  timeoutMs: number;
  memoryLimitBytes: number;
  maxOutputChars: number;
  maxNestedResultChars: number;
  resultFormat: SpindleResultFormat;
}

export interface SpindleApprovalConfig {
  read: SpindleApprovalMode;
  write: SpindleApprovalMode;
  execute: SpindleApprovalMode;
  network: SpindleApprovalMode;
  agent: SpindleApprovalMode;
  model?: string;
}

/** Bounds and defaults for `agents.run` / `agents.runAll`. */
export interface SpindleAgentConfig {
  maxPerExecution: number;
  timeoutMs: number;
  defaultModel?: string;
  defaultThinking?: string;
}

export interface SpindleToolCaptureConfig {
  enabled: boolean;
  hideFromModel: boolean;
  keepVisible: string[];
  defaultRisk: SpindleRisk;
  risks: Record<string, SpindleRisk>;
}

interface SpindleUiConfig {
  enabled: boolean;
  widget: SpindleUiWidgetMode;
  maxRows: number;
  refreshMs: number;
  showNestedToolCalls: boolean;
  nestedToolDebounceMs: number;
}

export interface SpindleConfig {
  fullCodeMode: boolean;
  executor: SpindleExecutorConfig;
  approvals: SpindleApprovalConfig;
  agents: SpindleAgentConfig;
  capture: SpindleToolCaptureConfig;
  ui: SpindleUiConfig;
}

export const MIN_AGENT_TIMEOUT_MS = 1_000;
const DEFAULT_AGENT_TIMEOUT_MS = 30 * 60_000;
export const MAX_AGENT_TIMEOUT_MS = 24 * 3_600_000;
export const QUICKJS_MAX_MEMORY_LIMIT_BYTES = 0xffff_ffff;
export const MAX_EXECUTOR_MEMORY_LIMIT_BYTES = Math.max(
  8 * 1024 * 1024,
  Math.min(Number.MAX_SAFE_INTEGER, Math.floor(os.totalmem())),
);

export const maxExecutorMemoryLimitBytes = (): number =>
  Math.min(QUICKJS_MAX_MEMORY_LIMIT_BYTES, MAX_EXECUTOR_MEMORY_LIMIT_BYTES);

export const DEFAULT_SPINDLE_CONFIG: SpindleConfig = {
  fullCodeMode: true,
  executor: {
    runtime: "quickjs",
    timeoutMs: 120_000,
    memoryLimitBytes: 64 * 1024 * 1024,
    maxOutputChars: 100_000,
    maxNestedResultChars: 2_000_000,
    resultFormat: "auto",
  },
  approvals: {
    read: "allow",
    write: "allow",
    execute: "allow",
    network: "allow",
    agent: "allow",
  },
  agents: {
    maxPerExecution: 100,
    timeoutMs: DEFAULT_AGENT_TIMEOUT_MS,
  },
  capture: {
    enabled: true,
    hideFromModel: true,
    keepVisible: ["spindle_exec"],
    defaultRisk: "execute",
    risks: {
      read: "read",
      grep: "read",
      find: "read",
      ls: "read",
      edit: "write",
      write: "write",
      bash: "execute",
    },
  },
  ui: {
    enabled: true,
    widget: "auto",
    maxRows: 6,
    refreshMs: 500,
    showNestedToolCalls: true,
    nestedToolDebounceMs: 100,
  },
};

interface JsonObjectFile {
  document: Record<string, unknown>;
  source: string;
}

const readJsonObjectFile = (filePath: string): JsonObjectFile | undefined => {
  try {
    const source = fs.readFileSync(filePath, "utf8");
    const parsed: unknown = JSON.parse(source);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("configuration root must be an object");
    }
    return { document: parsed as Record<string, unknown>, source };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read ${filePath}: ${message}`);
  }
};

const mergeObjects = (
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> => {
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const baseValue = merged[key];
    if (
      typeof baseValue === "object" &&
      baseValue !== null &&
      !Array.isArray(baseValue) &&
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    ) {
      merged[key] = mergeObjects(
        baseValue as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      merged[key] = value;
    }
  }
  return merged;
};

const approvalMode = (value: unknown, fallback: SpindleApprovalMode): SpindleApprovalMode =>
  value === "allow" || value === "ask" || value === "auto" || value === "deny"
    ? value
    : fallback;

const booleanValue = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

const boundedInteger = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === "number" && Number.isInteger(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

const thinkingValue = (value: unknown): string | undefined =>
  typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value)
    ? value
    : undefined;

const objectValue = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const widgetModeValue = (value: unknown, fallback: SpindleUiWidgetMode): SpindleUiWidgetMode =>
  value === "auto" || value === "always" || value === "hidden" ? value : fallback;

const resultFormatValue = (
  value: unknown,
  fallback: SpindleResultFormat,
): SpindleResultFormat =>
  value === "auto" || value === "yaml" || value === "json" || value === "text"
    ? value
    : fallback;

const riskValue = (value: unknown, fallback: SpindleRisk): SpindleRisk =>
  value === "read" ||
  value === "write" ||
  value === "execute" ||
  value === "network" ||
  value === "agent"
    ? value
    : fallback;

export const normalizeSpindleConfig = (input: Record<string, unknown>): SpindleConfig => {
  const executor = objectValue(input.executor);
  const approvals = objectValue(input.approvals);
  const agents = objectValue(input.agents);
  const capture = objectValue(input.capture);
  const ui = objectValue(input.ui);
  const approvalModel = stringValue(approvals.model);
  const agentModel = stringValue(agents.defaultModel);
  const agentThinking = thinkingValue(agents.defaultThinking);
  const configuredVisible = Array.isArray(capture.keepVisible)
    ? capture.keepVisible.filter(
        (name): name is string => typeof name === "string" && Boolean(name.trim()),
      )
    : DEFAULT_SPINDLE_CONFIG.capture.keepVisible;
  const configuredRisks = {
    ...DEFAULT_SPINDLE_CONFIG.capture.risks,
    ...objectValue(capture.risks),
  };
  const risks = Object.fromEntries(
    Object.entries(configuredRisks)
      .filter(([name]) => Boolean(name.trim()))
      .map(([name, risk]) => [name, riskValue(risk, DEFAULT_SPINDLE_CONFIG.capture.defaultRisk)]),
  );

  return {
    fullCodeMode: booleanValue(input.fullCodeMode, DEFAULT_SPINDLE_CONFIG.fullCodeMode),
    executor: {
      runtime: "quickjs",
      timeoutMs: boundedInteger(
        executor.timeoutMs,
        DEFAULT_SPINDLE_CONFIG.executor.timeoutMs,
        1_000,
        900_000,
      ),
      memoryLimitBytes: boundedInteger(
        executor.memoryLimitBytes,
        DEFAULT_SPINDLE_CONFIG.executor.memoryLimitBytes,
        8 * 1024 * 1024,
        maxExecutorMemoryLimitBytes(),
      ),
      maxOutputChars: boundedInteger(
        executor.maxOutputChars,
        DEFAULT_SPINDLE_CONFIG.executor.maxOutputChars,
        1_000,
        1_000_000,
      ),
      maxNestedResultChars: boundedInteger(
        executor.maxNestedResultChars,
        DEFAULT_SPINDLE_CONFIG.executor.maxNestedResultChars,
        10_000,
        20_000_000,
      ),
      resultFormat: resultFormatValue(
        executor.resultFormat,
        DEFAULT_SPINDLE_CONFIG.executor.resultFormat,
      ),
    },
    approvals: {
      read: approvalMode(approvals.read, DEFAULT_SPINDLE_CONFIG.approvals.read),
      write: approvalMode(approvals.write, DEFAULT_SPINDLE_CONFIG.approvals.write),
      execute: approvalMode(approvals.execute, DEFAULT_SPINDLE_CONFIG.approvals.execute),
      network: approvalMode(approvals.network, DEFAULT_SPINDLE_CONFIG.approvals.network),
      agent: approvalMode(approvals.agent, DEFAULT_SPINDLE_CONFIG.approvals.agent),
      ...(approvalModel ? { model: approvalModel } : {}),
    },
    agents: {
      maxPerExecution: boundedInteger(
        agents.maxPerExecution,
        DEFAULT_SPINDLE_CONFIG.agents.maxPerExecution,
        1,
        1_000,
      ),
      timeoutMs: boundedInteger(
        agents.timeoutMs,
        DEFAULT_SPINDLE_CONFIG.agents.timeoutMs,
        MIN_AGENT_TIMEOUT_MS,
        MAX_AGENT_TIMEOUT_MS,
      ),
      ...(agentModel ? { defaultModel: agentModel } : {}),
      ...(agentThinking ? { defaultThinking: agentThinking } : {}),
    },
    capture: {
      enabled: booleanValue(capture.enabled, DEFAULT_SPINDLE_CONFIG.capture.enabled),
      hideFromModel: booleanValue(
        capture.hideFromModel,
        DEFAULT_SPINDLE_CONFIG.capture.hideFromModel,
      ),
      keepVisible: [...new Set(configuredVisible)],
      defaultRisk: riskValue(capture.defaultRisk, DEFAULT_SPINDLE_CONFIG.capture.defaultRisk),
      risks,
    },
    ui: {
      enabled: booleanValue(ui.enabled, DEFAULT_SPINDLE_CONFIG.ui.enabled),
      widget: widgetModeValue(ui.widget, DEFAULT_SPINDLE_CONFIG.ui.widget),
      maxRows: boundedInteger(ui.maxRows, DEFAULT_SPINDLE_CONFIG.ui.maxRows, 1, 20),
      refreshMs: boundedInteger(ui.refreshMs, DEFAULT_SPINDLE_CONFIG.ui.refreshMs, 100, 10_000),
      showNestedToolCalls: booleanValue(
        ui.showNestedToolCalls,
        DEFAULT_SPINDLE_CONFIG.ui.showNestedToolCalls,
      ),
      nestedToolDebounceMs: boundedInteger(
        ui.nestedToolDebounceMs,
        DEFAULT_SPINDLE_CONFIG.ui.nestedToolDebounceMs,
        0,
        2_000,
      ),
    },
  };
};

export const effectiveToolCaptureConfig = (
  config: Pick<SpindleConfig, "fullCodeMode" | "capture">,
): SpindleToolCaptureConfig =>
  config.fullCodeMode
    ? {
        ...config.capture,
        keepVisible: config.capture.keepVisible.filter(
          (name) => !PI_CORE_TOOL_NAME_SET.has(name),
        ),
        risks: { ...config.capture.risks },
      }
    : {
        ...config.capture,
        enabled: false,
        hideFromModel: false,
        keepVisible: [...config.capture.keepVisible],
        risks: { ...config.capture.risks },
      };

interface SpindleConfigFilePlan {
  path: string;
  document: Record<string, unknown>;
  source: string;
  changed: boolean;
}

const planConfigFile = (filePath: string): SpindleConfigFilePlan | undefined => {
  const input = readJsonObjectFile(filePath);
  if (!input) return undefined;
  const migration = migrateSpindleConfigDocument(input.document);
  return {
    path: filePath,
    document: migration.document,
    source: input.source,
    changed: migration.changed,
  };
};

const writeJsonAtomic = (
  filePath: string,
  document: Record<string, unknown>,
  expectedSource?: string,
): void => {
  const resolvedPath = fs.existsSync(filePath) ? fs.realpathSync(filePath) : filePath;
  const directory = path.dirname(resolvedPath);
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
  const mode = fs.existsSync(resolvedPath) ? fs.statSync(resolvedPath).mode & 0o777 : 0o600;
  const temporaryPath = path.join(
    directory,
    `.${path.basename(resolvedPath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporaryPath, "wx", mode);
    fs.writeFileSync(descriptor, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    if (expectedSource !== undefined) {
      let currentSource: string;
      try {
        currentSource = fs.readFileSync(resolvedPath, "utf8");
      } catch (error) {
        throw new Error(`Spindle configuration changed while updating ${filePath}`, { cause: error });
      }
      if (currentSource !== expectedSource) {
        throw new Error(`Spindle configuration changed while updating ${filePath}`);
      }
    }
    fs.renameSync(temporaryPath, resolvedPath);
    try {
      const directoryDescriptor = fs.openSync(directory, "r");
      try {
        fs.fsyncSync(directoryDescriptor);
      } finally {
        fs.closeSync(directoryDescriptor);
      }
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR") throw error;
    }
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
};

/** Spindle's own config file name; deliberately not the upstream config file. */
const SPINDLE_CONFIG_FILENAME = "spindle.json";

export const loadSpindleConfig = (options: {
  cwd: string;
  agentDir: string;
  projectTrusted: boolean;
}): SpindleConfig => {
  let merged = structuredClone(DEFAULT_SPINDLE_CONFIG) as unknown as Record<string, unknown>;
  const plans = [
    planConfigFile(path.join(options.agentDir, SPINDLE_CONFIG_FILENAME)),
    ...(options.projectTrusted
      ? [planConfigFile(path.join(options.cwd, ".pi", SPINDLE_CONFIG_FILENAME))]
      : []),
  ].filter((plan): plan is SpindleConfigFilePlan => plan !== undefined);
  for (const plan of plans) {
    if (plan.changed) writeJsonAtomic(plan.path, plan.document, plan.source);
    merged = mergeObjects(merged, plan.document);
  }
  const inheritedFullCodeMode = process.env.PI_SPINDLE_FULL_CODE_MODE;
  if (inheritedFullCodeMode === "true" || inheritedFullCodeMode === "false") {
    merged.fullCodeMode = inheritedFullCodeMode === "true";
  }
  return normalizeSpindleConfig(merged);
};

export const saveSpindleConfig = (
  options: { cwd: string; agentDir: string; projectTrusted: boolean },
  partial: Record<string, unknown>,
): { scope: "global" | "project"; path: string } => {
  const targetPath = options.projectTrusted
    ? path.join(options.cwd, ".pi", SPINDLE_CONFIG_FILENAME)
    : path.join(options.agentDir, SPINDLE_CONFIG_FILENAME);
  if (Object.hasOwn(partial, "configVersion")) {
    throw new Error("Spindle configuration updates must use the current schema");
  }
  const input = readJsonObjectFile(targetPath);
  const existing = migrateSpindleConfigDocument(input?.document ?? {}).document;
  const merged = mergeObjects(existing, partial) as Record<string, unknown>;
  merged.configVersion = CURRENT_SPINDLE_CONFIG_VERSION;
  writeJsonAtomic(targetPath, merged, input?.source);
  return { scope: options.projectTrusted ? "project" : "global", path: targetPath };
};
