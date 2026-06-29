/**
 * secrets extension for pi
 *
 * - Injects secrets (from fnox CLI) as env vars into bash commands
 * - Scrubs secret values from all tool output (bash, read, grep, etc.)
 *   with partial masking: prefix****suffix so the agent can tell what kind
 *   of secret it is (e.g. `gho_ab****ef`).
 * - Adds available secret names to the system prompt
 * - Provides /secret-list command
 *
 * Secrets are loaded from the fnox CLI (`fnox export --format json`).
 * Pattern-based masking also applies to recognized formats (GitHub tokens,
 * API keys, JWTs, AWS keys, etc.) even without fnox.
 *
 * Install:
 *   Place in ~/.pi/agent/extensions/secrets.ts
 *   Or add to ~/.pi/agent/settings.json: { "extensions": ["/path/to/secrets"] }
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLocalBashOperations, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { scrubText, type SecretEntry } from "./secret-mask";

/**
 * Find the nearest fnox.toml file by searching up from cwd
 */
/**
 * Resolve the shell pi is configured to use, so ! commands match the agent
 * bash tool. Reads shellPath from pi's global settings.json, falls back to
 * $SHELL, then undefined (which lets pi pick its default).
 */
function resolveShellPath(): string | undefined {
	try {
		const settingsPath = join(homedir(), ".pi", "agent", "settings.json");
		if (existsSync(settingsPath)) {
			const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			if (typeof settings.shellPath === "string" && settings.shellPath) {
				return settings.shellPath;
			}
		}
	} catch {
		// Ignore and fall through
	}
	return process.env.SHELL || undefined;
}

function findFnoxConfig(cwd: string): string | null {
	let dir = cwd;
	for (let i = 0; i < 20; i++) {
		const configPath = join(dir, "fnox.toml");
		if (existsSync(configPath)) {
			return configPath;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

/**
 * Load secrets from fnox using the CLI
 */
async function loadSecrets(): Promise<SecretEntry[]> {
	try {
		const output = execSync("fnox export --format json 2>/dev/null", {
			encoding: "utf8",
			timeout: 10000,
		});
		const data = JSON.parse(output);
		const entries: SecretEntry[] = [];

		for (const [name, value] of Object.entries(data.secrets ?? {})) {
			entries.push({ name, value: String(value) });
		}

		return entries;
	} catch {
		return [];
	}
}

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();

	// Find fnox config (for displaying config path in /secret-list)
	const configPath = findFnoxConfig(cwd);

	// Track loaded secrets in memory (lazy loaded)
	let cachedSecrets: SecretEntry[] | null = null;
	let cacheTime = 0;
	const CACHE_TTL = 30000; // 30 seconds

	const getSecrets = async (): Promise<SecretEntry[]> => {
		const now = Date.now();
		if (cachedSecrets && now - cacheTime < CACHE_TTL) {
			return cachedSecrets;
		}
		cachedSecrets = await loadSecrets();
		cacheTime = now;
		return cachedSecrets;
	};

	// Inject secrets into bash tool calls by prepending fnox export
	pi.on("tool_call", async (event) => {
		if (!isToolCallEventType("bash", event)) return;

		const secrets = await getSecrets();
		if (secrets.length === 0) return;

		// Prepend fnox export command to inject secrets as env vars
		event.input.command = `eval "$(fnox export)"\n${event.input.command}`;
	});

	// Scrub secrets from all tool results (pattern + URL + env masking always runs;
	// fnox exact-value masking also runs when secrets are available)
	pi.on("tool_result", async (event) => {
		const secrets = await getSecrets();

		const scrubbed = event.content.map((c: any) =>
			c.type === "text" ? { ...c, text: scrubText(c.text, secrets) } : c,
		);

		return { content: scrubbed };
	});

	// Inject secrets into user ! commands too
	pi.on("user_bash", () => {
		// Respect the configured shellPath (pi ignores $SHELL by default and
		// createLocalBashOperations() with no arg falls back to /bin/bash).
		const localOps = createLocalBashOperations({ shellPath: resolveShellPath() });
		return {
			operations: {
				exec: async (command: string, execCwd: string, options: any) => {
					const secrets = await getSecrets();
					const injectedEnv: Record<string, string> = {};
					for (const secret of secrets) {
						injectedEnv[secret.name] = secret.value;
					}
					// executeBashWithOperations does not pass env, so options.env is
					// undefined here. Base the merge on process.env so PATH (and HOME,
					// etc.) are preserved; otherwise the spawned shell has no PATH.
					return localOps.exec(command, execCwd, {
						...options,
						env: { ...process.env, ...options.env, ...injectedEnv },
					});
				},
			},
		};
	});

	// Inject secret names into system prompt so the LLM knows what's available
	pi.on("before_agent_start", async (event) => {
		const secrets = await getSecrets();
		if (secrets.length === 0) return;

		const names = secrets.map((s) => s.name).join(", ");
		const instruction = [
			"\n## secrets — Secret Management",
			`Available secrets (injected as env vars in bash): ${names}`,
			"Use $SECRET_NAME in bash commands to reference secrets. Never ask the user for secret values.",
			"Secret values are partially masked in command output (shown as prefix****suffix, e.g. gho_ab****ef). Pattern-based masking also applies to recognized secret formats (GitHub tokens, API keys, JWTs, etc.).",
		].join("\n");

		return { systemPrompt: event.systemPrompt + instruction };
	});

	// Command to list secrets (names only, never values)
	pi.registerCommand("secret-list", {
		description: "List secrets",
		handler: async (_args, ctx) => {
			const secrets = await getSecrets();
			if (secrets.length === 0) {
				ctx.ui.notify(
					"No secrets found. Ensure fnox is initialized with 'fnox init' and secrets are set with 'fnox set'.",
					"info",
				);
				return;
			}

			const configDir = configPath ? dirname(configPath) : "(unknown)";
			const configName = configPath ? basename(configPath) : "(unknown)";
			const formatLine = (s: SecretEntry) => `  • ${s.name}`;
			const list = secrets.map(formatLine).join("\n");
			ctx.ui.notify(
				`secrets (from ${configName} in ${configDir}):\n${list}`,
				"info",
			);

			// Also let the model see the list on the next turn
			const modelList = secrets.map((s) => s.name).join(", ");
			pi.sendMessage(
				{
					customType: "secret-event",
					content: `User listed secrets: ${modelList}.`,
					display: true,
				},
				{ deliverAs: "nextTurn" },
			);
		},
	});
}
