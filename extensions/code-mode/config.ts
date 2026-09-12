/**
 * TRIMMED from upstream `src/config.ts`.
 *
 * The `mesh`, `memory`, `schema`, `compaction`, `retention`, `mcp` (upstream's
 * own embedded MCP client) and `prewalk` sections were removed with their
 * subsystems. `agents` is
 * repurposed for the absorbed subagents runner. `executor.runtime` is narrowed
 * to `"quickjs"` because the Node-process runtime is not vendored.
 *
 * The config file is `code-mode.json`, NOT the upstream project's own config
 * file, so code-mode never reads or writes upstream's user configuration.
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
import { CURRENT_CODE_MODE_CONFIG_VERSION, migrateCodeModeConfigDocument } from "./config-migrations.ts";
export type CodeModeUiWidgetMode = "auto" | "always" | "hidden";
export type CodeModeResultFormat = "auto" | "yaml" | "json" | "text";
/** QuickJS is the only vendored runtime; the Node-process escape hatch is dropped. */
export type CodeModeExecutorRuntime = "quickjs";

/** Thinking levels the absorbed subagents runner accepts (see agents/pi-args.ts). */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

interface CodeModeExecutorConfig {
	runtime: CodeModeExecutorRuntime;
	timeoutMs: number;
	/**
	 * Policy ceiling for a per-invocation `timeoutMs` request: a single
	 * `code_mode` call may raise (never lower) `timeoutMs` up to this value.
	 */
	maxTimeoutMs: number;
	memoryLimitBytes: number;
	/**
	 * Ceiling on what one `pi.read` may hand a program, in bytes.
	 *
	 * pi's own read limit (2000 lines / 50 KB) is a context-window budget, and the
	 * sandbox is not context: a read result is a string in the guest, and only
	 * what a program returns is charged to the model (`maxOutputChars`). So the
	 * sandbox reads whole files up to this ceiling instead.
	 *
	 * It is a ceiling and not an absence of one because guest strings live in the
	 * QuickJS heap (`memoryLimitBytes`) and cross the host bridge as a copy: past
	 * a few megabytes the honest answer is to filter the file in `pi.bash` rather
	 * than to OOM the program halfway through it.
	 */
	readMaxBytes: number;
	maxOutputChars: number;
	maxNestedResultChars: number;
	resultFormat: CodeModeResultFormat;
}

/** Bounds and defaults for the `agents.*` actions. */
export interface CodeModeAgentConfig {
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
export interface CodeModeSandboxConfig {
	mode: SandboxMode;
	/** Extra writable roots, beyond the cwd and the tool caches. */
	allowWrite: string[];
	/** Replaces the default deny-write patterns when non-empty. */
	denyWrite: string[];
	/** Replaces the default denied read paths when non-empty. */
	denyRead: string[];
}

export interface CodeModeToolCaptureConfig {
	enabled: boolean;
	hideFromModel: boolean;
	keepVisible: string[];
}

interface CodeModeUiConfig {
	enabled: boolean;
	widget: CodeModeUiWidgetMode;
	maxRows: number;
	refreshMs: number;
	showNestedToolCalls: boolean;
	nestedToolDebounceMs: number;
}

export interface CodeModeConfig {
	fullCodeMode: boolean;
	executor: CodeModeExecutorConfig;
	agents: CodeModeAgentConfig;
	sandbox: CodeModeSandboxConfig;
	/**
	 * Read-only guardrail for MCP tool calls. Unrelated to the upstream `mcp`
	 * section removed above: this configures a policy, not an MCP client.
	 */
	mcp: McpReadOnlyConfig;
	capture: CodeModeToolCaptureConfig;
	ui: CodeModeUiConfig;
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

export const DEFAULT_CODE_MODE_CONFIG: CodeModeConfig = {
	fullCodeMode: true,
	executor: {
		runtime: "quickjs",
		timeoutMs: 120_000,
		maxTimeoutMs: 900_000,
		memoryLimitBytes: 64 * 1024 * 1024,
		readMaxBytes: 8 * 1024 * 1024,
		maxOutputChars: 30_000,
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
	},
	mcp: DEFAULT_MCP_READ_ONLY_CONFIG,
	capture: {
		enabled: true,
		hideFromModel: true,
		keepVisible: ["code_mode"],
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

const widgetModeValue = (value: unknown, fallback: CodeModeUiWidgetMode): CodeModeUiWidgetMode =>
	value === "auto" || value === "always" || value === "hidden" ? value : fallback;

const resultFormatValue = (value: unknown, fallback: CodeModeResultFormat): CodeModeResultFormat =>
	value === "auto" || value === "yaml" || value === "json" || value === "text" ? value : fallback;

export const normalizeCodeModeConfig = (input: Record<string, unknown>): CodeModeConfig => {
	const executor = objectValue(input.executor);
	const agents = objectValue(input.agents);
	const sandbox = objectValue(input.sandbox);
	const capture = objectValue(input.capture);
	const ui = objectValue(input.ui);
	const agentModel = stringValue(agents.defaultModel);
	const agentThinking = thinkingValue(agents.defaultThinking);
	const configuredVisible = Array.isArray(capture.keepVisible)
		? capture.keepVisible
				.filter((name): name is string => typeof name === "string" && Boolean(name.trim()))
				.map((name) => name.trim())
		: DEFAULT_CODE_MODE_CONFIG.capture.keepVisible;

	return {
		fullCodeMode: booleanValue(input.fullCodeMode, DEFAULT_CODE_MODE_CONFIG.fullCodeMode),
		executor: {
			runtime: "quickjs",
			timeoutMs: boundedInteger(executor.timeoutMs, DEFAULT_CODE_MODE_CONFIG.executor.timeoutMs, 1_000, 900_000),
			maxTimeoutMs: Math.max(
				boundedInteger(executor.timeoutMs, DEFAULT_CODE_MODE_CONFIG.executor.timeoutMs, 1_000, 900_000),
				boundedInteger(executor.maxTimeoutMs, DEFAULT_CODE_MODE_CONFIG.executor.maxTimeoutMs, 1_000, 3_600_000),
			),
			memoryLimitBytes: boundedInteger(
				executor.memoryLimitBytes,
				DEFAULT_CODE_MODE_CONFIG.executor.memoryLimitBytes,
				8 * 1024 * 1024,
				maxExecutorMemoryLimitBytes(),
			),
			readMaxBytes: boundedInteger(
				executor.readMaxBytes,
				DEFAULT_CODE_MODE_CONFIG.executor.readMaxBytes,
				// Never below pi's own limit (that would make the sandbox worse than the
				// model's own read), never above what the guest heap can hold.
				50 * 1024,
				maxExecutorMemoryLimitBytes(),
			),
			maxOutputChars: boundedInteger(
				executor.maxOutputChars,
				DEFAULT_CODE_MODE_CONFIG.executor.maxOutputChars,
				1_000,
				1_000_000,
			),
			maxNestedResultChars: boundedInteger(
				executor.maxNestedResultChars,
				DEFAULT_CODE_MODE_CONFIG.executor.maxNestedResultChars,
				10_000,
				20_000_000,
			),
			resultFormat: resultFormatValue(executor.resultFormat, DEFAULT_CODE_MODE_CONFIG.executor.resultFormat),
		},
		agents: {
			maxPerExecution: boundedInteger(
				agents.maxPerExecution,
				DEFAULT_CODE_MODE_CONFIG.agents.maxPerExecution,
				1,
				1_000,
			),
			timeoutMs: boundedInteger(
				agents.timeoutMs,
				DEFAULT_CODE_MODE_CONFIG.agents.timeoutMs,
				MIN_AGENT_TIMEOUT_MS,
				MAX_AGENT_TIMEOUT_MS,
			),
			waitMs: boundedInteger(
				agents.waitMs,
				DEFAULT_CODE_MODE_CONFIG.agents.waitMs,
				MIN_AGENT_TIMEOUT_MS,
				MAX_AGENT_TIMEOUT_MS,
			),
			...(agentModel ? { defaultModel: agentModel } : {}),
			...(agentThinking ? { defaultThinking: agentThinking } : {}),
		},
		sandbox: {
			mode: isSandboxMode(sandbox.mode) ? sandbox.mode : DEFAULT_CODE_MODE_CONFIG.sandbox.mode,
			allowWrite: stringList(sandbox.allowWrite),
			denyWrite: stringList(sandbox.denyWrite),
			denyRead: stringList(sandbox.denyRead),
		},
		mcp: normalizeMcpReadOnlyConfig(input.mcp),
		capture: {
			enabled: booleanValue(capture.enabled, DEFAULT_CODE_MODE_CONFIG.capture.enabled),
			hideFromModel: booleanValue(capture.hideFromModel, DEFAULT_CODE_MODE_CONFIG.capture.hideFromModel),
			keepVisible: [...new Set(configuredVisible)],
		},
		ui: {
			enabled: booleanValue(ui.enabled, DEFAULT_CODE_MODE_CONFIG.ui.enabled),
			widget: widgetModeValue(ui.widget, DEFAULT_CODE_MODE_CONFIG.ui.widget),
			maxRows: boundedInteger(ui.maxRows, DEFAULT_CODE_MODE_CONFIG.ui.maxRows, 1, 20),
			refreshMs: boundedInteger(ui.refreshMs, DEFAULT_CODE_MODE_CONFIG.ui.refreshMs, 100, 10_000),
			showNestedToolCalls: booleanValue(ui.showNestedToolCalls, DEFAULT_CODE_MODE_CONFIG.ui.showNestedToolCalls),
			nestedToolDebounceMs: boundedInteger(
				ui.nestedToolDebounceMs,
				DEFAULT_CODE_MODE_CONFIG.ui.nestedToolDebounceMs,
				0,
				2_000,
			),
		},
	};
};

export const effectiveToolCaptureConfig = (
	config: Pick<CodeModeConfig, "fullCodeMode" | "capture">,
): CodeModeToolCaptureConfig =>
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

interface CodeModeConfigFilePlan {
	path: string;
	document: Record<string, unknown>;
	source: string;
	changed: boolean;
}

const planConfigFile = (filePath: string): CodeModeConfigFilePlan | undefined => {
	const input = readJsonObjectFile(filePath);
	if (!input) return undefined;
	const migration = migrateCodeModeConfigDocument(input.document);
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
				throw new Error(`Code Mode configuration changed while updating ${filePath}`, { cause: error });
			}
			if (currentSource !== expectedSource) {
				throw new Error(`Code Mode configuration changed while updating ${filePath}`);
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

/** Code Mode's own config file name; deliberately not the upstream config file. */
const CODE_MODE_CONFIG_FILENAME = "code-mode.json";

export const loadCodeModeConfig = (options: {
	cwd: string;
	agentDir: string;
	projectTrusted: boolean;
}): CodeModeConfig => {
	let merged = structuredClone(DEFAULT_CODE_MODE_CONFIG) as unknown as Record<string, unknown>;
	const plans = [
		planConfigFile(path.join(options.agentDir, CODE_MODE_CONFIG_FILENAME)),
		...(options.projectTrusted ? [planConfigFile(path.join(options.cwd, ".pi", CODE_MODE_CONFIG_FILENAME))] : []),
	].filter((plan): plan is CodeModeConfigFilePlan => plan !== undefined);
	for (const plan of plans) {
		if (plan.changed) writeJsonAtomic(plan.path, plan.document, plan.source);
		merged = mergeObjects(merged, plan.document);
	}
	const inheritedFullCodeMode = process.env.PI_CODE_MODE_FULL_CODE_MODE;
	if (inheritedFullCodeMode === "true" || inheritedFullCodeMode === "false") {
		merged.fullCodeMode = inheritedFullCodeMode === "true";
	}
	return normalizeCodeModeConfig(merged);
};

export const saveCodeModeConfig = (
	options: { cwd: string; agentDir: string; projectTrusted: boolean },
	partial: Record<string, unknown>,
): { scope: "global" | "project"; path: string } => {
	const targetPath = options.projectTrusted
		? path.join(options.cwd, ".pi", CODE_MODE_CONFIG_FILENAME)
		: path.join(options.agentDir, CODE_MODE_CONFIG_FILENAME);
	if (Object.hasOwn(partial, "configVersion")) {
		throw new Error("Code Mode configuration updates must use the current schema");
	}
	const input = readJsonObjectFile(targetPath);
	const existing = migrateCodeModeConfigDocument(input?.document ?? {}).document;
	const merged = mergeObjects(existing, partial) as Record<string, unknown>;
	merged.configVersion = CURRENT_CODE_MODE_CONFIG_VERSION;
	writeJsonAtomic(targetPath, merged, input?.source);
	return { scope: options.projectTrusted ? "project" : "global", path: targetPath };
};
