/**
 * Shell selection for the Seatbelt backend.
 *
 * The same shell is used both inside `sandbox-exec -- <shell> -c` and for the
 * unsandboxed local fallback (`lateBoundBashOperations` in `manager.ts`), so
 * sandboxed and unsandboxed `bash` behave identically. A Homebrew shell is
 * exactly why the profile's read-allow rule grants `file-map-executable`
 * (`seatbelt-profile.ts`): without it the configured shell cannot map its own
 * dylibs and `sandbox-exec` fails to exec anything at all.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Read `shellPath` from pi's settings, falling back to `/bin/bash`. Mirrors
 * `extensions/secrets/index.ts`'s `resolveShellPath` (same key, same
 * swallow-and-fallback behaviour); kept as a local copy rather than an
 * import across extensions.
 */
export function resolveShellPath(): string {
	try {
		const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
		const settingsPath = join(agentDir, "settings.json");
		if (existsSync(settingsPath)) {
			const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
			if (settings && typeof settings.shellPath === "string" && settings.shellPath.trim()) {
				return settings.shellPath;
			}
		}
	} catch {
		// Ignore and fall through to the default.
	}
	return "/bin/bash";
}

/**
 * Single-quote `value` for a shell word. Twin of `night-mode/preflight.ts`'s
 * `shellQuote`; kept as a local copy rather than an import across extensions.
 */
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}
