/**
 * Minimal settings reader for resolving the default model provider.
 *
 * The agents' frontmatter often uses a bare model name (e.g. `claude-opus-4-8`)
 * with no `provider/` prefix. When we spawn a child `pi` with an explicit
 * `--model` that carries a thinking suffix (e.g. `claude-opus-4-8:low`), pi
 * resolves the bare, suffixed name to the wrong provider (Amazon Bedrock's
 * `us.anthropic.claude-opus-4-8`) instead of the user's configured provider.
 * Qualifying the model as `anthropic/claude-opus-4-8:low` routes it correctly.
 *
 * We mirror how the parent resolves models: read `defaultProvider` from project
 * settings first, then user settings.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** User-scope agent directory (matches the `workspaces` extension). */
function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function readSettings(settingsPath: string): Record<string, unknown> | undefined {
	try {
		if (!existsSync(settingsPath)) return undefined;
		const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		// Malformed or unreadable settings: fall through to the next scope.
		return undefined;
	}
}

function readDefaultProviderFrom(settingsPath: string): string | undefined {
	const parsed = readSettings(settingsPath);
	const value = parsed?.defaultProvider;
	if (typeof value === "string" && value.trim()) return value.trim();
	return undefined;
}

/**
 * Read `enabledModels` from a single settings file. Returns the trimmed,
 * non-empty string entries, or undefined when the key is absent/invalid so the
 * caller can fall through to the next scope. An explicit empty array yields [].
 */
function readEnabledModelsFrom(settingsPath: string): string[] | undefined {
	const parsed = readSettings(settingsPath);
	if (!parsed || !("enabledModels" in parsed)) return undefined;
	const value = parsed.enabledModels;
	if (!Array.isArray(value)) return undefined;
	return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim());
}

/**
 * Resolve the default model provider. Project `<cwd>/.pi/settings.json` wins
 * over user `${PI_CODING_AGENT_DIR|~/.pi/agent}/settings.json`. Returns
 * undefined when neither sets `defaultProvider`. Never throws.
 */
export function readDefaultProvider(cwd: string): string | undefined {
	const project = readDefaultProviderFrom(join(cwd, ".pi", "settings.json"));
	if (project) return project;
	return readDefaultProviderFrom(join(agentDir(), "settings.json"));
}

/**
 * Resolve the model allowlist the user has enabled. Project
 * `<cwd>/.pi/settings.json` wins over user settings (same precedence as
 * `defaultProvider`). Returns [] when neither scope sets `enabledModels`, which
 * callers treat as "no restriction". Never throws.
 */
export function readEnabledModels(cwd: string): string[] {
	const project = readEnabledModelsFrom(join(cwd, ".pi", "settings.json"));
	if (project !== undefined) return project;
	return readEnabledModelsFrom(join(agentDir(), "settings.json")) ?? [];
}
