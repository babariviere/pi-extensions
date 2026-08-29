/**
 * Configuration for the night-mode run prompt: where the base prompt, the
 * extra instructions and the report live, plus the safety caps applied to an
 * unattended run.
 *
 * Pure except for `readNightConfig`, which reads pi's settings files the same
 * way `spindle/agents/settings.ts` does (project overrides user).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { isWakeLockPreference, type WakeLockPreference } from "./wake-lock.ts";

export interface NightConfig {
	/** Base prompt injected on `/night start`. */
	promptPath: string;
	/** Extra, one-shot instructions. Archived and truncated when the run settles. */
	instructionsPath: string;
	/** Report destination. Supports `{datetime}`, `{date}`, `{time}` placeholders. */
	reportPathTemplate: string;
	/** Where consumed instruction files are moved. Empty string disables archiving. */
	archiveDir: string;
	/**
	 * Root for per-run working copies. `/night start` clones the cwd under
	 * `<sandboxRoot>/<repo>/<datetime>` and points the run at it, so the agent
	 * never touches the checkout you left open. Empty string disables cloning.
	 */
	sandboxRoot: string;
	/**
	 * Gitignored, repo-relative files copied into a fresh working copy. Local
	 * toolchain config and credentials live here, and a copy strategy that lost
	 * them would fail in a way that looks like a broken repo.
	 */
	sandboxCopyFiles: string[];
	/**
	 * Filesystem sandbox requested from Spindle for the duration of the run. The
	 * working copy, the report directory and the ledger store stay writable;
	 * everything else on the disk does not. `"off"` disables the request.
	 */
	sandboxMode: "off" | "read-only" | "workspace-write" | "full";
	/**
	 * Extra roots the run may write to, on top of the ones derived from it. For
	 * nights that touch a repository other than the one the run was started from,
	 * which the derived set cannot know about. `~` is expanded and relative paths
	 * resolve against the cwd.
	 */
	sandboxAllowWrite: string[];
	/**
	 * Run `mise trust` / `direnv allow` on a fresh working copy. Both tools trust
	 * by path, so without this every `mise` command in the copy hard-fails with an
	 * untrusted-config error.
	 */
	sandboxTrust: boolean;
	/**
	 * How sleep is suppressed during a run. `auto` uses Amphetamine when it is
	 * installed and falls back to `caffeinate`. Amphetamine is the only option
	 * that survives closing the lid, and only when its "Allow system sleep when
	 * display is closed" default is off.
	 */
	wakeLock: WakeLockPreference;
	/** Hard cap on pull requests a single night may open. */
	maxPullRequests: number;
	/** `## ` headings seeded into a fresh report, in order. */
	reportSections: string[];
}

/**
 * Default home of the night files. Everything is configurable, so someone who
 * keeps their prompts in a notes vault points `nightMode` at it instead.
 */
function defaultNightDir(): string {
	return join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "night");
}

/** Sections seeded into a fresh report. Override per workflow. */
export const DEFAULT_REPORT_SECTIONS = ["Summary", "Needs you", "Work", "Findings", "Skipped / failed", "Timeline"];

/** Heading the extension writes blockers and leftovers under. */
export const NEEDS_HUMAN_HEADING = DEFAULT_REPORT_SECTIONS[1];

export const DEFAULT_NIGHT_CONFIG: NightConfig = {
	promptPath: join(defaultNightDir(), "prompt.md"),
	instructionsPath: join(defaultNightDir(), "instructions.md"),
	reportPathTemplate: join(defaultNightDir(), "reports", "{datetime} - report.md"),
	archiveDir: join(defaultNightDir(), "archive"),
	sandboxRoot: join(defaultNightDir(), "sandboxes"),
	sandboxCopyFiles: ["mise.local.toml"],
	sandboxMode: "workspace-write",
	sandboxAllowWrite: [],
	sandboxTrust: true,
	wakeLock: "auto",
	maxPullRequests: 5,
	reportSections: DEFAULT_REPORT_SECTIONS,
};

/** Expand a leading `~` to the home directory. Other paths are returned as-is. */
export function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

/** Absolute form of `path`, resolved against `base` when relative. */
export function resolvePath(path: string, base: string): string {
	const expanded = expandHome(path);
	return isAbsolute(expanded) ? expanded : join(base, expanded);
}

const pad = (value: number): string => String(value).padStart(2, "0");

/** `2026-08-29`. */
export function formatDateStamp(date: Date): string {
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** `2130`. */
export function formatTimeStamp(date: Date): string {
	return `${pad(date.getHours())}${pad(date.getMinutes())}`;
}

/** `2026-08-29 2130`. */
export function formatDateTimeStamp(date: Date): string {
	return `${formatDateStamp(date)} ${formatTimeStamp(date)}`;
}

/**
 * Expand `{datetime}`, `{date}` and `{time}` in a path template. Also accepts
 * the `<datetime>` spelling, since that is how the paths read in prose.
 */
export function applyPathTemplate(template: string, date: Date): string {
	const values: Record<string, string> = {
		datetime: formatDateTimeStamp(date),
		date: formatDateStamp(date),
		time: formatTimeStamp(date),
	};
	return template.replace(/[{<](datetime|date|time)[}>]/g, (_match, key: string) => values[key]);
}

/** Absolute report path for a run started at `date`. */
export function reportPathFor(config: NightConfig, date: Date, base: string): string {
	return resolvePath(applyPathTemplate(config.reportPathTemplate, date), base);
}

/** Basename without extension, for tools that link notes by name. */
export function noteNameFor(path: string): string {
	const file = path.split("/").pop() ?? path;
	return file.replace(/\.md$/i, "");
}

function readJson(path: string): Record<string, unknown> | undefined {
	try {
		if (!existsSync(path)) return undefined;
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

/** Merge a raw `nightMode` settings object over the defaults, ignoring junk. */
const NIGHT_SANDBOX_MODES = ["off", "read-only", "workspace-write", "full"] as const;

/** Narrow an untrusted settings value to a sandbox mode. */
function isNightSandboxMode(value: unknown): value is NightConfig["sandboxMode"] {
	return typeof value === "string" && (NIGHT_SANDBOX_MODES as readonly string[]).includes(value);
}

export function mergeNightConfig(raw: unknown, base: NightConfig = DEFAULT_NIGHT_CONFIG): NightConfig {
	const record =
		typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
	const str = (key: keyof NightConfig, fallback: string): string => {
		const value = record[key];
		return typeof value === "string" && value.trim() ? value.trim() : fallback;
	};
	const maxPullRequests = record.maxPullRequests;
	const copyFiles = Array.isArray(record.sandboxCopyFiles)
		? record.sandboxCopyFiles.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
		: undefined;
	// An empty array is meaningful here ("no extra roots"), so it is kept rather
	// than falling back to the base like the lists whose default is non-empty.
	const allowWrite = Array.isArray(record.sandboxAllowWrite)
		? record.sandboxAllowWrite
				.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
				.map((v) => v.trim())
		: undefined;
	const sections = Array.isArray(record.reportSections)
		? record.reportSections
				.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
				.map((v) => v.trim())
		: undefined;
	return {
		promptPath: str("promptPath", base.promptPath),
		instructionsPath: str("instructionsPath", base.instructionsPath),
		reportPathTemplate: str("reportPathTemplate", base.reportPathTemplate),
		archiveDir: typeof record.archiveDir === "string" ? record.archiveDir.trim() : base.archiveDir,
		sandboxRoot: typeof record.sandboxRoot === "string" ? record.sandboxRoot.trim() : base.sandboxRoot,
		sandboxCopyFiles: copyFiles ?? base.sandboxCopyFiles,
		sandboxMode: isNightSandboxMode(record.sandboxMode) ? record.sandboxMode : base.sandboxMode,
		sandboxAllowWrite: allowWrite ?? base.sandboxAllowWrite,
		sandboxTrust: typeof record.sandboxTrust === "boolean" ? record.sandboxTrust : base.sandboxTrust,
		wakeLock: isWakeLockPreference(record.wakeLock) ? record.wakeLock : base.wakeLock,
		maxPullRequests:
			typeof maxPullRequests === "number" && Number.isFinite(maxPullRequests) && maxPullRequests > 0
				? Math.floor(maxPullRequests)
				: base.maxPullRequests,
		reportSections: sections?.length ? sections : base.reportSections,
	};
}

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/**
 * Resolve the night config from `nightMode` in pi's settings. Project
 * `<cwd>/.pi/settings.json` wins over user settings. Never throws.
 */
export function readNightConfig(cwd: string): NightConfig {
	const user = readJson(join(agentDir(), "settings.json"))?.nightMode;
	const project = readJson(join(cwd, ".pi", "settings.json"))?.nightMode;
	return mergeNightConfig(project, mergeNightConfig(user));
}
