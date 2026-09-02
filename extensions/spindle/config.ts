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
	DEFAULT_MCP_READ_ONLY_CONFIG,
	type McpReadOnlyConfig,
	normalizeMcpReadOnlyConfig,
} from "./mcp/read-only-policy.ts";
import { isSandboxMode, type SandboxMode } from "./sandbox/policy.ts";
import { CURRENT_SPINDLE_CONFIG_VERSION, migrateSpindleConfigDocument } from "./config-migrations.ts";
export type SpindleUiWidgetMode = "auto" | "always" | "hidden";
export type SpindleResultFormat = "auto" | "yaml" | "json" | "text";
/** QuickJS is the only vendored runtime; the Node-process escape hatch is dropped. */
export type SpindleExecutorRuntime = "quickjs";

/** Thinking levels the absorbed subagents runner accepts (see agents/pi-args.ts). */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

interface SpindleExecutorConfig {
	runtime: SpindleExecutorRuntime;
	timeoutMs: number;
	/**
	 * Policy ceiling for a per-invocation `timeoutMs` request: a single
	 * `spindle_exec` call may raise (never lower) `timeoutMs` up to this value.
	 */
	maxTimeoutMs: number;
	memoryLimitBytes: number;
	maxOutputChars: number;
	maxNestedResultChars: number;
	resultFormat: SpindleResultFormat;
}

/** Bounds and defaults for the `agents.*` actions. */
export interface SpindleAgentConfig {
	maxPerExecution: number;
	/** Hard cap on a child run's own lifetime; the child is killed past it. */
	timeoutMs: number;
	/**
	 * How long `agents.run` / `agents.runAll` block before handing control back.
	 * Past it the run keeps going in the background: the caller gets a `runId` to
	 * poll with `agents.wait`, and an unclaimed result is injected into the parent
	 * session as a follow-up message. Shorter than `timeoutMs` on purpose, so a
	 * long run never holds a turn hostage.
	 */
	waitMs: number;
	defaultModel?: string;
	defaultThinking?: string;
}

/**
 * Filesystem guardrail for the mutating core tools (see `sandbox/`).
 *
 * Defaults to `off`: an interactive session routinely writes outside its cwd
 * (notes, sibling repos, agent files), so enforcement is opt-in per project or
 * turned on for the duration of an unattended run.
 */
export interface SpindleSandboxConfig {
	mode: SandboxMode;
	/** Extra writable roots, beyond the cwd and the tool caches. */
	allowWrite: string[];
	/** Replaces the default deny-write patterns when non-empty. */
	denyWrite: string[];
	/** Replaces the default denied read paths when non-empty. */
	denyRead: string[];
	/** Domain allowlist for the sandbox network proxy. `*` means unrestricted. */
	allowedDomains: string[];
	deniedDomains: string[];
}

export interface SpindleToolCaptureConfig {
	enabled: boolean;
	hideFromModel: boolean;
	keepVisible: string[];
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
	agents: SpindleAgentConfig;
	sandbox: SpindleSandboxConfig;
	/**
	 * Read-only guardrail for MCP tool calls. Unrelated to the upstream `mcp`
	 * section removed above: this configures a policy, not an MCP client.
	 */
	mcp: McpReadOnlyConfig;
	capture: SpindleToolCaptureConfig;
	ui: SpindleUiConfig;
}

export const MIN_AGENT_TIMEOUT_MS = 1_000;
// A child may run long because waiting on it is bounded (`waitMs`) and
// detachable, so the parent is never blocked for this whole window. It stays a
// hard cap so a wedged run cannot live forever.
const DEFAULT_AGENT_TIMEOUT_MS = 2 * 60 * 60_000;
const DEFAULT_AGENT_WAIT_MS = 10 * 60_000;
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
		maxTimeoutMs: 900_000,
		memoryLimitBytes: 64 * 1024 * 1024,
		maxOutputChars: 100_000,
		maxNestedResultChars: 2_000_000,
		resultFormat: "auto",
	},
	agents: {
		maxPerExecution: 100,
		timeoutMs: DEFAULT_AGENT_TIMEOUT_MS,
		waitMs: DEFAULT_AGENT_WAIT_MS,
	},
	sandbox: {
		mode: "off",
		allowWrite: [],
		denyWrite: [],
		denyRead: [],
		allowedDomains: ["*"],
		deniedDomains: [],
	},
	mcp: DEFAULT_MCP_READ_ONLY_CONFIG,
	capture: {
		enabled: true,
		hideFromModel: true,
		keepVisible: ["spindle_exec"],
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

const mergeObjects = (base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> => {
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
			merged[key] = mergeObjects(baseValue as Record<string, unknown>, value as Record<string, unknown>);
		} else {
			merged[key] = value;
		}
	}
	return merged;
};

const booleanValue = (value: unknown, fallback: boolean): boolean => (typeof value === "boolean" ? value : fallback);

const boundedInteger = (value: unknown, fallback: number, min: number, max: number): number =>
	typeof value === "number" && Number.isInteger(value) ? Math.max(min, Math.min(max, value)) : fallback;

const stringValue = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim() ? value : undefined;

const thinkingValue = (value: unknown): string | undefined =>
	typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value) ? value : undefined;

/** Trimmed, non-empty string entries of an array value; `fallback` when absent. */
const stringList = (value: unknown, fallback: string[] = []): string[] =>
	Array.isArray(value)
		? value
				.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
				.map((entry) => entry.trim())
		: fallback;

const objectValue = (value: unknown): Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const widgetModeValue = (value: unknown, fallback: SpindleUiWidgetMode): SpindleUiWidgetMode =>
	value === "auto" || value === "always" || value === "hidden" ? value : fallback;

const resultFormatValue = (value: unknown, fallback: SpindleResultFormat): SpindleResultFormat =>
	value === "auto" || value === "yaml" || value === "json" || value === "text" ? value : fallback;

export const normalizeSpindleConfig = (input: Record<string, unknown>): SpindleConfig => {
	const executor = objectValue(input.executor);
	const agents = objectValue(input.agents);
	const sandbox = objectValue(input.sandbox);
	const capture = objectValue(input.capture);
	const ui = objectValue(input.ui);
	const agentModel = stringValue(agents.defaultModel);
	const agentThinking = thinkingValue(agents.defaultThinking);
	const configuredVisible = Array.isArray(capture.keepVisible)
		? capture.keepVisible.filter((name): name is string => typeof name === "string" && Boolean(name.trim()))
		: DEFAULT_SPINDLE_CONFIG.capture.keepVisible;

	return {
		fullCodeMode: booleanValue(input.fullCodeMode, DEFAULT_SPINDLE_CONFIG.fullCodeMode),
		executor: {
			runtime: "quickjs",
			timeoutMs: boundedInteger(executor.timeoutMs, DEFAULT_SPINDLE_CONFIG.executor.timeoutMs, 1_000, 900_000),
			maxTimeoutMs: Math.max(
				boundedInteger(executor.timeoutMs, DEFAULT_SPINDLE_CONFIG.executor.timeoutMs, 1_000, 900_000),
				boundedInteger(executor.maxTimeoutMs, DEFAULT_SPINDLE_CONFIG.executor.maxTimeoutMs, 1_000, 3_600_000),
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
			resultFormat: resultFormatValue(executor.resultFormat, DEFAULT_SPINDLE_CONFIG.executor.resultFormat),
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
			waitMs: boundedInteger(
				agents.waitMs,
				DEFAULT_SPINDLE_CONFIG.agents.waitMs,
				MIN_AGENT_TIMEOUT_MS,
				MAX_AGENT_TIMEOUT_MS,
			),
			...(agentModel ? { defaultModel: agentModel } : {}),
			...(agentThinking ? { defaultThinking: agentThinking } : {}),
		},
		sandbox: {
			mode: isSandboxMode(sandbox.mode) ? sandbox.mode : DEFAULT_SPINDLE_CONFIG.sandbox.mode,
			allowWrite: stringList(sandbox.allowWrite),
			denyWrite: stringList(sandbox.denyWrite),
			denyRead: stringList(sandbox.denyRead),
			allowedDomains: stringList(sandbox.allowedDomains, DEFAULT_SPINDLE_CONFIG.sandbox.allowedDomains),
			deniedDomains: stringList(sandbox.deniedDomains),
		},
		mcp: normalizeMcpReadOnlyConfig(input.mcp),
		capture: {
			enabled: booleanValue(capture.enabled, DEFAULT_SPINDLE_CONFIG.capture.enabled),
			hideFromModel: booleanValue(capture.hideFromModel, DEFAULT_SPINDLE_CONFIG.capture.hideFromModel),
			keepVisible: [...new Set(configuredVisible)],
		},
		ui: {
			enabled: booleanValue(ui.enabled, DEFAULT_SPINDLE_CONFIG.ui.enabled),
			widget: widgetModeValue(ui.widget, DEFAULT_SPINDLE_CONFIG.ui.widget),
			maxRows: boundedInteger(ui.maxRows, DEFAULT_SPINDLE_CONFIG.ui.maxRows, 1, 20),
			refreshMs: boundedInteger(ui.refreshMs, DEFAULT_SPINDLE_CONFIG.ui.refreshMs, 100, 10_000),
			showNestedToolCalls: booleanValue(ui.showNestedToolCalls, DEFAULT_SPINDLE_CONFIG.ui.showNestedToolCalls),
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
				keepVisible: config.capture.keepVisible.filter((name) => !PI_CORE_TOOL_NAME_SET.has(name)),
			}
		: {
				...config.capture,
				enabled: false,
				hideFromModel: false,
				keepVisible: [...config.capture.keepVisible],
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

const writeJsonAtomic = (filePath: string, document: Record<string, unknown>, expectedSource?: string): void => {
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
		...(options.projectTrusted ? [planConfigFile(path.join(options.cwd, ".pi", SPINDLE_CONFIG_FILENAME))] : []),
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
