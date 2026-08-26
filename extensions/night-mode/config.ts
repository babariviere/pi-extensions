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

export interface NightConfig {
	/** Base prompt injected on `/night start`. */
	promptPath: string;
	/** Extra, one-shot instructions. Archived and truncated when the run settles. */
	instructionsPath: string;
	/** Report destination. Supports `{datetime}`, `{date}`, `{time}` placeholders. */
	reportPathTemplate: string;
	/** Where consumed instruction files are moved. Empty string disables archiving. */
	archiveDir: string;
	/** Hard cap on pull requests a single night may open. */
	maxPullRequests: number;
}

const WORK_AGENT_DIR = join(homedir(), "Documents", "Work", "Agent");

export const DEFAULT_NIGHT_CONFIG: NightConfig = {
	promptPath: join(WORK_AGENT_DIR, "Night Prompt.md"),
	instructionsPath: join(WORK_AGENT_DIR, "Night Instructions.md"),
	reportPathTemplate: join(WORK_AGENT_DIR, "{datetime} - Night Report.md"),
	archiveDir: join(WORK_AGENT_DIR, "Archive"),
	maxPullRequests: 5,
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

/** `2026-08-29`, matching the vault's note naming convention. */
export function formatDateStamp(date: Date): string {
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** `2130`, matching the vault's note naming convention. */
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
	return template.replace(
		/[{<](datetime|date|time)[}>]/g,
		(_match, key: string) => values[key],
	);
}

/** Absolute report path for a run started at `date`. */
export function reportPathFor(
	config: NightConfig,
	date: Date,
	base: string,
): string {
	return resolvePath(applyPathTemplate(config.reportPathTemplate, date), base);
}

/** Obsidian note name (basename without extension) for a wiki-link. */
export function noteNameFor(path: string): string {
	const file = path.split("/").pop() ?? path;
	return file.replace(/\.md$/i, "");
}

function readJson(path: string): Record<string, unknown> | undefined {
	try {
		if (!existsSync(path)) return undefined;
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		return parsed && typeof parsed === "object"
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

/** Merge a raw `nightMode` settings object over the defaults, ignoring junk. */
export function mergeNightConfig(
	raw: unknown,
	base: NightConfig = DEFAULT_NIGHT_CONFIG,
): NightConfig {
	const record =
		typeof raw === "object" && raw !== null && !Array.isArray(raw)
			? (raw as Record<string, unknown>)
			: {};
	const str = (key: keyof NightConfig, fallback: string): string => {
		const value = record[key];
		return typeof value === "string" && value.trim() ? value.trim() : fallback;
	};
	const maxPullRequests = record.maxPullRequests;
	return {
		promptPath: str("promptPath", base.promptPath),
		instructionsPath: str("instructionsPath", base.instructionsPath),
		reportPathTemplate: str("reportPathTemplate", base.reportPathTemplate),
		archiveDir:
			typeof record.archiveDir === "string"
				? record.archiveDir.trim()
				: base.archiveDir,
		maxPullRequests:
			typeof maxPullRequests === "number" &&
			Number.isFinite(maxPullRequests) &&
			maxPullRequests > 0
				? Math.floor(maxPullRequests)
				: base.maxPullRequests,
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
