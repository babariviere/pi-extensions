/**
 * tool-substitute
 *
 * Suggests modern alternatives and blocks git (which auto-converts where safe).
 * - git -> jj ( Jujutsu VCS )  [enforced]
 * - find -> fd ( faster alternative )  [suggestion only]
 * - grep -> rg ( ripgrep )  [suggestion only]
 *
 * Simple git commands that map cleanly to jj (clone/init/fetch/push) are
 * auto-converted to their `jj git <subcommand>` equivalents instead of being
 * blocked.
 *
 * find/grep are only suggested in the system prompt, never blocked, since the
 * agent does not always translate them to fd/rg correctly.
 *
 * Also injects these rules into the system prompt via before_agent_start.
 *
 * Note: matching is token-position based, not a real shell parse, so commands
 * embedded in quoted strings (e.g. `echo "git clone x"`) are matched too.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const replacements: Record<string, string> = {
	git: "jj",
	find: "fd",
	grep: "rg",
};

/**
 * Shell operators that separate commands, i.e. tokens after which a new
 * command position begins (&&, ||, |, ;, &, newlines, $( and backtick).
 */
const SHELL_OPERATORS = "&&|\\|\\||[|;&\\n]|\\$\\(|`";

/**
 * Resolve the effective command name for one segment, looking past common
 * prefixes that would otherwise hide the real command:
 *   - leading env assignments: `GIT_PAGER=cat git log`
 *   - the `env` launcher (with its own assignments/flags): `env git push`
 *   - absolute/relative paths: `/usr/bin/git`, `./git` -> basename `git`
 * Best-effort only (token-based, not a real shell parse).
 */
function effectiveCommandName(segment: string): string {
	const tokens = segment.trim().split(/\s+/).filter(Boolean);
	let i = 0;
	// Skip leading VAR=value env assignments.
	while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
	// Skip an `env` launcher plus its flags and inline assignments.
	if (i < tokens.length && basename(tokens[i]) === "env") {
		i++;
		while (i < tokens.length && (tokens[i].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]))) i++;
	}
	if (i >= tokens.length) return "";
	return basename(tokens[i]);
}

/** Final path component, stripping any directory prefix (e.g. /usr/bin/git -> git). */
function basename(token: string): string {
	const parts = token.split("/");
	return parts[parts.length - 1] ?? token;
}

/**
 * Extract command names from a shell command string.
 * Only returns words that appear in command position (first token after
 * shell operators like &&, ||, |, ;, &, newlines, or start of string).
 */
function getCommandNames(command: string): string[] {
	const segments = command.split(new RegExp(`\\s*(?:${SHELL_OPERATORS})\\s*`));
	return segments.map((seg) => effectiveCommandName(seg)).filter(Boolean);
}

// Only git is enforced (with auto-conversion). find/grep are suggestions only.
const forbiddenSet = new Set(["git"]);

/**
 * Auto-fixes grep-style recursive flags wrongly passed to `rg`.
 *
 * In ripgrep recursion is the default and `-r`/`--replace` consumes the next
 * characters as a replacement string, so `rg -rn`, `rg -rli`, `rg -R`, etc.
 * (grep muscle memory) silently mangle output. We rewrite:
 *   - `-R` and `--recursive` -> dropped (no recursive flag needed in rg)
 *   - short-flag clusters bundling r/R -> the r/R is stripped
 *     (`-rn` -> `-n`, `-rli` -> `-li`, `-rln` -> `-ln`)
 * A standalone `-r` is left alone since it is a legitimate `--replace`.
 *
 * Only the leading flag run (before the search pattern) is inspected, so
 * patterns that happen to look like flags are not touched.
 */
function fixRgRecursiveFlags(command: string): string {
	// Split while preserving the shell-operator separators so we can rejoin.
	const parts = command.split(new RegExp(`(\\s*(?:${SHELL_OPERATORS})\\s*)`));
	for (let i = 0; i < parts.length; i += 2) {
		const seg = parts[i];
		const m = seg.match(/^(\s*rg\s+)([\s\S]*)$/);
		if (!m) continue;
		const head = m[1];
		const rest = m[2];
		// Leading run of flag tokens (each starts with "-").
		const lead = rest.match(/^((?:-\S+(?:\s+|$))*)/)?.[1] ?? "";
		const tail = rest.slice(lead.length);
		const newToks: string[] = [];
		for (const tok of lead.trim().split(/\s+/).filter(Boolean)) {
			if (tok === "-R" || tok === "--recursive") continue; // drop
			if (/^-[a-zA-Z]+$/.test(tok) && tok.length >= 3 && /[rR]/.test(tok)) {
				const fixed = tok.replace(/[rR]/g, "");
				if (fixed !== "-") newToks.push(fixed);
				continue;
			}
			newToks.push(tok);
		}
		const newLead = newToks.length ? newToks.join(" ") + (tail ? " " : "") : "";
		parts[i] = head + newLead + tail;
	}
	return parts.join("");
}

/**
 * git subcommands that map cleanly to `jj git <subcommand>`.
 * These are simple, safe conversions with identical argument semantics.
 */
const gitPassthrough = ["clone", "init", "fetch", "push"];

/**
 * Matches `git <subcommand>` when `git` is in command position (start of
 * string or after a shell operator) and the subcommand is auto-convertible.
 */
const gitConvertRegex = new RegExp(
	`(^\\s*|(?:${SHELL_OPERATORS})\\s*)git(\\s+(?:${gitPassthrough.join("|")})\\b)`,
	"g",
);

const systemPromptAddition = `
## Tool Substitution Rules
Instead of using the following commands, use their modern alternatives:
${Object.entries(replacements)
	.map(([forbidden, tool]) => `- \`${forbidden}\` -> \`${tool}\``)
	.join("\n")}
`;

export default function (pi: ExtensionAPI) {
	// Inject substitution rules into system prompt on each turn
	pi.on("before_agent_start", async (event, _ctx) => {
		return { systemPrompt: event.systemPrompt + systemPromptAddition };
	});

	// Block forbidden commands
	pi.on("tool_call", async (event, _ctx) => {
		if (event.toolName !== "bash") return undefined;

		let command = (event.input.command as string) ?? "";

		// Auto-convert simple git commands to their jj equivalents instead of
		// blocking them (e.g. `git clone <url>` -> `jj git clone <url>`).
		const converted = command.replace(gitConvertRegex, (_m, prefix, rest) => `${prefix}jj git${rest}`);
		if (converted !== command) {
			command = converted;
			event.input.command = converted;
		}

		// Auto-fix grep-style recursive flags on rg (e.g. `rg -rn`, `rg -R`),
		// which silently mangle output via --replace. A bare `-r` is left alone.
		const rgFixed = fixRgRecursiveFlags(command);
		if (rgFixed !== command) {
			command = rgFixed;
			event.input.command = rgFixed;
		}

		const commandNames = getCommandNames(command);
		const forbidden = commandNames.find((name) => forbiddenSet.has(name));

		if (!forbidden) return undefined;

		const tool = replacements[forbidden];

		return { block: true, reason: `Forbidden command '${forbidden}' blocked. Use '${tool}' instead.` };
	});
}