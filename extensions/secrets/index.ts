/**
 * secrets extension for pi
 *
 * - Injects secrets (from fnox CLI) as env vars into bash commands
 * - Replaces secret values in tool output with reversible references
 *   (`<secret:github-token:9f2c4ab1>`, see secret-ref.ts) and expands them
 *   again when the model writes them back to a file
 * - Adds available secret names to the system prompt
 * - Provides /secret-list command
 *
 * Secrets are loaded from the fnox CLI (`fnox export --format json`).
 * Pattern-based detection also applies to recognized formats (GitHub tokens,
 * API keys, JWTs, AWS keys, etc.) even without fnox.
 *
 * Install:
 *   Place in ~/.pi/agent/extensions/secrets/ (this file is the entrypoint).
 *   Or add to ~/.pi/agent/settings.json: { "extensions": ["/path/to/secrets"] }
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { createLocalBashOperations, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { applySecretPolicy } from "./secret-policy";
import { scrubContent, scrubDeep, type SecretEntry } from "./secret-mask";
import { REF_KEY_ENV, SecretRefRegistry } from "./secret-ref";

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

/** Find the nearest fnox.toml file by searching up from cwd. */
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

	// Ref registry. The session key is inherited by child pi processes so refs
	// minted by a parent resolve identically in a subagent; values are not passed,
	// so a child only resolves what it re-derives from fnox or sees itself.
	const registry = new SecretRefRegistry(process.env[REF_KEY_ENV]);
	process.env[REF_KEY_ENV] = registry.key;

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
		// Registering up front is what makes authoring refs (`<secret:NAME>`) work for
		// a secret the model has never seen in any tool output.
		for (const secret of cachedSecrets) {
			if (secret.value.length >= 8) registry.registerNamed(secret.name, secret.value);
		}
		return cachedSecrets;
	};

	// Expand references on the way in, and inject env vars for bash.
	pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
		// Only the file and shell tools need the fnox load, and a cache miss costs a
		// blocking execSync; the rest of the tools just need the ref grammar.
		const touchesSecrets =
			isToolCallEventType("bash", event) ||
			isToolCallEventType("write", event) ||
			isToolCallEventType("edit", event);
		const secrets = touchesSecrets ? await getSecrets() : [];

		const outcome = applySecretPolicy(event, registry);
		if (outcome.block) return { block: true, reason: outcome.reason };
		if (outcome.notify) ctx.ui.notify(outcome.notify, "info");

		if (isToolCallEventType("bash", event) && secrets.length > 0) {
			// Prepend fnox export command to inject secrets as env vars
			event.input.command = `eval "$(fnox export)"\n${event.input.command}`;
		}
	});

	// Replace secret values with references in every tool result (pattern + URL +
	// env detection always runs; fnox exact-value matching also runs when secrets
	// are available).
	pi.on("tool_result", async (event) => {
		const secrets = await getSecrets();

		// scrubContent returns undefined when nothing changed (see its docstring for
		// why an untouched patch is harmful); cast keeps the SDK content-part union.
		const scrubbed = scrubContent(event.content as any[], secrets, registry);
		// details are persisted to the session file, so they are scrubbed too.
		// scrubDeep returns the input by reference when nothing changed, which is what
		// keeps an untouched result from being patched.
		const details = scrubDeep(event.details, secrets, registry);
		if (!scrubbed && details === event.details) return undefined;
		return { content: scrubbed ?? event.content, details };
	});

	// Inject secrets into user ! commands too
	pi.on("user_bash", () => {
		// Respect the configured shellPath (pi ignores $SHELL by default and
		// createLocalBashOperations() with no arg falls back to /bin/bash).
		const localOps = createLocalBashOperations({ shellPath: resolveShellPath() });
		return {
			operations: {
				exec: async (command: string, execCwd: string, options: Parameters<typeof localOps.exec>[2]) => {
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
			"Secret values never appear in tool output. They are replaced by references of the form `<secret:type:id>`.",
			"Copy a reference verbatim. Written to a file with write or edit, it expands to the real value; in bash it becomes the matching variable.",
			"To place a secret you have never seen into a file, write `<secret:NAME>` using a name from the list above.",
			"Never transcribe a partially masked value: that destroys the secret. Use the reference.",
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
			const formatLine = (s: SecretEntry) => {
				const entry = registry.lookupName(s.name);
				return entry ? `  • ${s.name}  ${entry.ref}` : `  • ${s.name}`;
			};
			const list = secrets.map(formatLine).join("\n");
			ctx.ui.notify(`secrets (from ${configName} in ${configDir}):\n${list}`, "info");

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
