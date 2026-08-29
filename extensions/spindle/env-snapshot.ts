/**
 * Allowlisted environment snapshot exposed to spindle_exec programs as
 * `process.env`.
 *
 * Only non-sensitive identity/locale/path variables cross the sandbox
 * boundary. A secret never enters the QuickJS guest, so nothing a program
 * prints, returns, or hands to a subagent can leak it. If a model needs a
 * real secret in bash, the secrets extension's `<\\secret:NAME>` reference
 * path is the supported channel.
 */

const EXACT_ENV_KEYS = ["HOME", "USER", "LOGNAME", "SHELL", "LANG", "TERM", "TMPDIR", "PATH"] as const;

const ENV_KEY_PREFIXES = ["LC_", "XDG_"] as const;

export interface SpindleProcessSnapshot {
	env: Record<string, string>;
	platform: string;
	arch: string;
	cwd: string;
}

export const spindleProcessSnapshot = (
	cwd: string,
	source: Record<string, string | undefined> = process.env,
): SpindleProcessSnapshot => {
	const env: Record<string, string> = {};
	for (const key of EXACT_ENV_KEYS) {
		const value = source[key];
		if (typeof value === "string" && value !== "") env[key] = value;
	}
	const prefixed = Object.keys(source)
		.filter((key) => ENV_KEY_PREFIXES.some((prefix) => key.startsWith(prefix)))
		.sort();
	for (const key of prefixed) {
		const value = source[key];
		if (typeof value === "string" && value !== "") env[key] = value;
	}
	// PWD follows the agent session, not the host process launch directory.
	env.PWD = cwd;
	return {
		env,
		platform: process.platform,
		arch: process.arch,
		cwd,
	};
};
