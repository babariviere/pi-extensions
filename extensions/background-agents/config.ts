import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type {
	AgentRole,
	BackgroundAgentsConfig,
	BackgroundSource,
	ProviderKind,
	RepositoryConfig,
	RolloutMode,
	ThresholdConfig,
} from "./types.ts";

export const BACKGROUND_AGENTS_CONFIG_VERSION = 1 as const;
export const DEFAULT_BACKGROUND_AGENTS_CONFIG_PATH = resolve(homedir(), ".pi", "agent", "background-agents.json");

const SOURCE_NAMES: readonly BackgroundSource[] = ["manual", "slack", "linear", "datadog"];
const ROLES: readonly AgentRole[] = ["classifier", "investigator", "spec-planner", "worker", "verifier"];
const PROVIDERS: readonly ProviderKind[] = ["anthropic", "openai"];
const ROLLOUT_MODES: readonly RolloutMode[] = ["observe", "supervised", "autonomous-pr"];

export const DEFAULT_BACKGROUND_AGENTS_CONFIG: BackgroundAgentsConfig = {
	configVersion: 1,
	databasePath: resolve(homedir(), ".pi", "agent", "background-agents.sqlite"),
	repositories: [],
	thresholds: { actionableMin: 70, noiseMax: 30 },
	pollIntervalsMs: { linear: 5 * 60_000, datadog: 60_000, slackReconnect: 5_000 },
	profiles: [],
	systemd: {
		maxRuntimeMs: 24 * 60 * 60_000,
		memoryLimitBytes: 2 * 1024 ** 3,
		cpuQuotaPercent: 100,
		processLimit: 256,
	},
	ci: { requiredChecks: [], maxWaitMs: 30 * 60_000 },
	socket: {
		path: resolve(homedir(), ".pi", "agent", "background-agents.sock"),
		mode: 0o600,
		maxRequestBytes: 1_048_576,
	},
	rollout: { defaultMode: "observe", sourceOverrides: {}, repositoryOverrides: {} },
	backup: {
		directory: resolve(homedir(), ".pi", "agent", "background-agent-backups"),
		intervalMs: 60 * 60_000,
		retention: 7,
	},
};

type RecordValue = Record<string, unknown>;

function recordValue(value: unknown, field: string): RecordValue {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
	return value as RecordValue;
}

function stringValue(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
	return value.trim();
}

function integerValue(value: unknown, field: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
		throw new Error(`${field} must be an integer between ${min} and ${max}`);
	}
	return value;
}

function stringList(value: unknown, field: string): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
	return value.map((item, index) => stringValue(item, `${field}[${index}]`));
}

function enumValue<T extends string | number>(value: unknown, field: string, values: readonly T[]): T {
	if (!values.includes(value as T)) throw new Error(`${field} is invalid`);
	return value as T;
}

function pathValue(value: unknown, field: string, baseDir: string): string {
	const input = stringValue(value, field);
	const expanded = input === "~" ? homedir() : input.startsWith("~/") ? resolve(homedir(), input.slice(2)) : input;
	return resolve(baseDir, expanded);
}

function threshold(value: unknown, field: string, fallback: number): number {
	return value === undefined ? fallback : integerValue(value, field, 0, 100);
}

function scopedThresholds(value: unknown, field: string, fallback: ThresholdConfig): Record<string, ThresholdConfig> {
	if (value === undefined) return {};
	const input = recordValue(value, field);
	return Object.fromEntries(
		Object.entries(input).map(([key, item]) => {
			const scoped = recordValue(item, `${field}.${key}`);
			const result = {
				actionableMin: threshold(scoped.actionableMin, `${field}.${key}.actionableMin`, fallback.actionableMin),
				noiseMax: threshold(scoped.noiseMax, `${field}.${key}.noiseMax`, fallback.noiseMax),
			};
			if (result.noiseMax >= result.actionableMin)
				throw new Error(`${field}.${key} noiseMax must be below actionableMin`);
			return [key, result];
		}),
	);
}

function validateNoInlineSecrets(value: unknown, path = "config"): void {
	if (Array.isArray(value)) {
		value.forEach((item, index) => validateNoInlineSecrets(item, `${path}[${index}]`));
		return;
	}
	if (!value || typeof value !== "object") return;
	for (const [key, child] of Object.entries(value)) {
		if (
			/(?:token|secret|password|api[-_]?key|client[-_]?secret|access[-_]?key)/i.test(key) &&
			!/(?:file|path|ref)$/i.test(key)
		) {
			throw new Error(`${path}.${key} must be a file or reference, not an inline secret`);
		}
		validateNoInlineSecrets(child, `${path}.${key}`);
	}
}

function repository(value: unknown, index: number, baseDir: string): RepositoryConfig {
	const input = recordValue(value, `repositories[${index}]`);
	const root = pathValue(input.root, `repositories[${index}].root`, baseDir);
	return {
		id: stringValue(input.id, `repositories[${index}].id`),
		root,
		gitDir: pathValue(input.gitDir ?? `${root}/.git`, `repositories[${index}].gitDir`, baseDir),
		requiredChecks: stringList(input.requiredChecks, `repositories[${index}].requiredChecks`),
	};
}

function validatePath(path: string, field: string, kind: "directory" | "file-or-directory"): void {
	if (!existsSync(path)) throw new Error(`${field} does not exist: ${path}`);
	const stats = statSync(path);
	if (kind === "directory" && !stats.isDirectory()) throw new Error(`${field} must be a directory: ${path}`);
}

function validateConfig(config: BackgroundAgentsConfig, checkPaths: boolean): BackgroundAgentsConfig {
	if (config.thresholds.noiseMax >= config.thresholds.actionableMin)
		throw new Error("thresholds.noiseMax must be below actionableMin");
	for (const scope of Object.values(config.thresholds.scopes ?? {})) {
		for (const item of Object.values(scope ?? {})) {
			if (item.noiseMax >= item.actionableMin) throw new Error("scoped noiseMax must be below actionableMin");
		}
	}
	if (config.socket.mode < 0o600 || config.socket.mode > 0o777 || (config.socket.mode & 0o007) !== 0) {
		throw new Error("socket.mode must be owner-readable/writable and not world-accessible");
	}
	if (new Set(config.repositories.map((item) => item.id)).size !== config.repositories.length)
		throw new Error("repository ids must be unique");
	if (new Set(config.profiles.map((item) => item.id)).size !== config.profiles.length)
		throw new Error("profile ids must be unique");
	if (checkPaths) {
		for (const item of config.repositories) {
			validatePath(item.root, `repository ${item.id}.root`, "directory");
			validatePath(item.gitDir, `repository ${item.id}.gitDir`, "file-or-directory");
		}
		for (const item of config.profiles) {
			validatePath(item.agentDir, `profile ${item.id}.agentDir`, "directory");
			for (const file of item.authFiles) validatePath(file, `profile ${item.id}.authFiles`, "file-or-directory");
		}
	}
	return config;
}

export function normalizeBackgroundAgentsConfig(
	input: Record<string, unknown> = {},
	baseDir = process.cwd(),
): BackgroundAgentsConfig {
	validateNoInlineSecrets(input);
	const databasePath = pathValue(
		input.databasePath ?? DEFAULT_BACKGROUND_AGENTS_CONFIG.databasePath,
		"databasePath",
		baseDir,
	);
	const rawThresholds = input.thresholds === undefined ? {} : recordValue(input.thresholds, "thresholds");
	const thresholds: ThresholdConfig = {
		actionableMin: threshold(rawThresholds.actionableMin, "thresholds.actionableMin", 70),
		noiseMax: threshold(rawThresholds.noiseMax, "thresholds.noiseMax", 30),
	};
	if (thresholds.noiseMax >= thresholds.actionableMin)
		throw new Error("thresholds.noiseMax must be below actionableMin");
	if (rawThresholds.scopes !== undefined) {
		const scopes = recordValue(rawThresholds.scopes, "thresholds.scopes");
		thresholds.scopes = {
			source: scopedThresholds(scopes.source, "thresholds.scopes.source", thresholds),
			service: scopedThresholds(scopes.service, "thresholds.scopes.service", thresholds),
			monitor: scopedThresholds(scopes.monitor, "thresholds.scopes.monitor", thresholds),
			environment: scopedThresholds(scopes.environment, "thresholds.scopes.environment", thresholds),
			repository: scopedThresholds(scopes.repository, "thresholds.scopes.repository", thresholds),
		};
	}
	const rawPolling = input.pollIntervalsMs === undefined ? {} : recordValue(input.pollIntervalsMs, "pollIntervalsMs");
	const rawSystemd = input.systemd === undefined ? {} : recordValue(input.systemd, "systemd");
	const rawCi = input.ci === undefined ? {} : recordValue(input.ci, "ci");
	const rawSocket = input.socket === undefined ? {} : recordValue(input.socket, "socket");
	const rawRollout = input.rollout === undefined ? {} : recordValue(input.rollout, "rollout");
	const rawBackup = input.backup === undefined ? {} : recordValue(input.backup, "backup");
	const sourceOverridesInput =
		rawRollout.sourceOverrides === undefined
			? {}
			: recordValue(rawRollout.sourceOverrides, "rollout.sourceOverrides");
	const repositoryOverridesInput =
		rawRollout.repositoryOverrides === undefined
			? {}
			: recordValue(rawRollout.repositoryOverrides, "rollout.repositoryOverrides");
	const repositoriesInput = input.repositories === undefined ? [] : input.repositories;
	if (!Array.isArray(repositoriesInput)) throw new Error("repositories must be an array");
	const profilesInput = input.profiles === undefined ? [] : input.profiles;
	if (!Array.isArray(profilesInput)) throw new Error("profiles must be an array");
	const profiles = profilesInput.map((value, index) => {
		const profile = recordValue(value, `profiles[${index}]`);
		return {
			id: stringValue(profile.id, `profiles[${index}].id`),
			provider: enumValue(profile.provider, `profiles[${index}].provider`, PROVIDERS),
			agentDir: pathValue(profile.agentDir, `profiles[${index}].agentDir`, baseDir),
			authFiles: stringList(profile.authFiles, `profiles[${index}].authFiles`).map((file) =>
				pathValue(file, `profiles[${index}].authFiles`, baseDir),
			),
			allowedModels: stringList(profile.allowedModels, `profiles[${index}].allowedModels`),
			allowedRoles: (profile.allowedRoles === undefined
				? [...ROLES]
				: stringList(profile.allowedRoles, `profiles[${index}].allowedRoles`)
			).map((role) => enumValue(role, `profiles[${index}].allowedRoles`, ROLES)),
			maxBackgroundAttempts: integerValue(
				profile.maxBackgroundAttempts ?? 1,
				`profiles[${index}].maxBackgroundAttempts`,
				1,
				100,
			),
			interactiveReserve: integerValue(
				profile.interactiveReserve ?? 1,
				`profiles[${index}].interactiveReserve`,
				0,
				100,
			),
			usageStaleAfterMs: integerValue(
				profile.usageStaleAfterMs ?? 15 * 60_000,
				`profiles[${index}].usageStaleAfterMs`,
				1_000,
			),
		};
	});
	const config: BackgroundAgentsConfig = {
		configVersion: enumValue(input.configVersion ?? 1, "configVersion", [1] as const),
		databasePath,
		repositories: repositoriesInput.map((value, index) => repository(value, index, baseDir)),
		thresholds,
		pollIntervalsMs: {
			linear: integerValue(rawPolling.linear ?? 5 * 60_000, "pollIntervalsMs.linear", 1_000),
			datadog: integerValue(rawPolling.datadog ?? 60_000, "pollIntervalsMs.datadog", 1_000),
			slackReconnect: integerValue(rawPolling.slackReconnect ?? 5_000, "pollIntervalsMs.slackReconnect", 1_000),
		},
		profiles,
		systemd: {
			maxRuntimeMs: integerValue(rawSystemd.maxRuntimeMs ?? 24 * 60 * 60_000, "systemd.maxRuntimeMs", 1_000),
			memoryLimitBytes: integerValue(
				rawSystemd.memoryLimitBytes ?? 2 * 1024 ** 3,
				"systemd.memoryLimitBytes",
				16 * 1024 * 1024,
			),
			cpuQuotaPercent: integerValue(rawSystemd.cpuQuotaPercent ?? 100, "systemd.cpuQuotaPercent", 1, 10_000),
			processLimit: integerValue(rawSystemd.processLimit ?? 256, "systemd.processLimit", 1, 100_000),
		},
		ci: {
			requiredChecks: stringList(rawCi.requiredChecks, "ci.requiredChecks"),
			maxWaitMs: integerValue(rawCi.maxWaitMs ?? 30 * 60_000, "ci.maxWaitMs", 1_000),
		},
		socket: {
			path: pathValue(rawSocket.path ?? DEFAULT_BACKGROUND_AGENTS_CONFIG.socket.path, "socket.path", baseDir),
			ownerUid:
				rawSocket.ownerUid === undefined ? undefined : integerValue(rawSocket.ownerUid, "socket.ownerUid", 0),
			mode: integerValue(rawSocket.mode ?? 0o600, "socket.mode", 0, 0o777),
			maxRequestBytes: integerValue(
				rawSocket.maxRequestBytes ?? 1_048_576,
				"socket.maxRequestBytes",
				1_024,
				16 * 1024 * 1024,
			),
		},
		rollout: {
			defaultMode: enumValue(rawRollout.defaultMode ?? "observe", "rollout.defaultMode", ROLLOUT_MODES),
			sourceOverrides: Object.fromEntries(
				Object.entries(sourceOverridesInput).map(([source, mode]) => [
					enumValue(source, "rollout.sourceOverrides", SOURCE_NAMES),
					enumValue(mode, `rollout.sourceOverrides.${source}`, ROLLOUT_MODES),
				]),
			),
			repositoryOverrides: Object.fromEntries(
				Object.entries(repositoryOverridesInput).map(([repositoryId, mode]) => [
					stringValue(repositoryId, "rollout.repositoryOverrides key"),
					enumValue(mode, `rollout.repositoryOverrides.${repositoryId}`, ROLLOUT_MODES),
				]),
			),
		},
		backup: {
			directory: pathValue(
				rawBackup.directory ?? DEFAULT_BACKGROUND_AGENTS_CONFIG.backup.directory,
				"backup.directory",
				baseDir,
			),
			intervalMs: integerValue(rawBackup.intervalMs ?? 60 * 60_000, "backup.intervalMs", 1_000),
			retention: integerValue(rawBackup.retention ?? 7, "backup.retention", 1, 10_000),
			syncCommand:
				rawBackup.syncCommand === undefined ? undefined : stringList(rawBackup.syncCommand, "backup.syncCommand"),
		},
	};
	return validateConfig(config, false);
}

export function validateBackgroundAgentsConfig(
	config: BackgroundAgentsConfig,
	options: { checkPaths?: boolean } = {},
): BackgroundAgentsConfig {
	return validateConfig(config, options.checkPaths === true);
}

export function loadBackgroundAgentsConfig(
	options: { path?: string; checkPaths?: boolean } = {},
): BackgroundAgentsConfig {
	const configPath = options.path ?? DEFAULT_BACKGROUND_AGENTS_CONFIG_PATH;
	if (!existsSync(configPath)) return normalizeBackgroundAgentsConfig({}, dirname(configPath));
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(configPath, "utf8"));
	} catch (error) {
		throw new Error(`Unable to read background-agent configuration at ${configPath}`, { cause: error });
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		throw new Error("configuration must be a JSON object");
	const config = normalizeBackgroundAgentsConfig(parsed as Record<string, unknown>, dirname(configPath));
	return validateBackgroundAgentsConfig(config, { checkPaths: options.checkPaths ?? true });
}
