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

function readDefaultProviderFrom(settingsPath: string): string | undefined {
	try {
		if (!existsSync(settingsPath)) return undefined;
		const parsed = JSON.parse(readFileSync(settingsPath, "utf-8")) as { defaultProvider?: unknown };
		if (typeof parsed.defaultProvider === "string" && parsed.defaultProvider.trim()) {
			return parsed.defaultProvider.trim();
		}
	} catch {
		// Malformed or unreadable settings: fall through to the next scope.
	}
	return undefined;
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
