/**
 * tool-substitute
 *
 * Keeps history mutations on jj and guides repository searches to Pi tools.
 * - git -> jj (Jujutsu VCS) [enforced only for writes inside a jj repo]
 * - pi.find and pi.grep are preferred for repository searches [suggestion only]
 *
 * git policy:
 * - Outside a jj repo, git is fully allowed (nothing to substitute with).
 * - Inside a jj repo, read-only git commands (log, status, diff, show, ...)
 *   are allowed, while commands that modify the repository are blocked.
 * - Simple git commands that map cleanly to jj (clone/init/fetch/push) are
 *   auto-converted to their `jj git <subcommand>` equivalents instead of
 *   being blocked, when running inside a jj repo.
 *
 * The jj check is per git invocation, not per tool call: `cd <dir> &&`,
 * `git -C <dir>`, and `bash -c '...'` are followed so a git write is judged
 * against the directory it actually runs in. Commands executed elsewhere
 * (ssh, docker, kubectl, ...) or in a directory that cannot be resolved
 * statically are left alone.
 *
 * Pi search tools are only suggested in the system prompt, never enforced.
 *
 * Also injects these rules into the system prompt via before_agent_start.
 *
 * Note: matching is token-position based, not a real shell parse, so commands
 * embedded in quoted strings (e.g. `echo "git commit"`) are matched too.
 */

import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const replacements: Record<string, string> = {
	git: "jj",
};

/**
 * Shell operators that separate commands, i.e. tokens after which a new
 * command position begins (&&, ||, |, ;, &, newlines, $( and backtick).
 */
const SHELL_OPERATORS = "&&|\\|\\||[|;&\\n]|\\$\\(|`";

/** Launchers that only prefix the real command and can be skipped. */
const WRAPPER_PREFIXES = new Set(["sudo", "doas", "nice", "ionice", "nohup", "stdbuf", "time", "command", "builtin"]);

/** Shells that take `-c '<command>'`, whose payload is scanned recursively. */
const SHELL_RUNNERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);

/**
 * Executors that run the command somewhere this process cannot inspect
 * (another host, container, or namespace). git inside them is never judged.
 */
const REMOTE_EXECUTORS = new Set([
	"ssh",
	"scp",
	"rsync",
	"docker",
	"podman",
	"nerdctl",
	"kubectl",
	"lxc",
	"distrobox",
	"toolbox",
	"flatpak",
	"vagrant",
]);

/**
 * Resolve the effective tokens for one segment, looking past prefixes that
 * would otherwise hide the real command:
 *   - leading env assignments: `GIT_PAGER=cat git log`
 *   - the `env` launcher (with its own assignments/flags): `env git push`
 *   - wrapper launchers and their flags: `sudo -E git commit`
 *   - absolute/relative paths: `/usr/bin/git`, `./git` -> basename `git`
 * Best-effort only (token-based, not a real shell parse).
 */
function effectiveTokens(segment: string): string[] {
	const tokens = segment.trim().split(/\s+/).filter(Boolean);
	let i = 0;
	for (;;) {
		// Skip leading VAR=value env assignments.
		while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
		if (i >= tokens.length) return [];
		const name = basename(tokens[i]);
		if (name !== "env" && !WRAPPER_PREFIXES.has(name)) break;
		// Skip the launcher plus its flags and inline assignments.
		i++;
		while (i < tokens.length && (tokens[i].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]))) i++;
	}
	return [basename(tokens[i]), ...tokens.slice(i + 1)];
}

/** Final path component, stripping any directory prefix (e.g. /usr/bin/git -> git). */
function basename(token: string): string {
	const parts = token.split("/");
	return parts[parts.length - 1] ?? token;
}

/**
 * git subcommands that modify the repository (history, refs, or working copy).
 * Anything not listed is treated as read-only.
 */
const gitWriteSubcommands = new Set([
	"add",
	"am",
	"apply",
	"branch",
	"checkout",
	"cherry-pick",
	"clean",
	"commit",
	"filter-branch",
	"gc",
	"merge",
	"mv",
	"notes",
	"prune",
	"pull",
	"rebase",
	"reset",
	"restore",
	"revert",
	"rm",
	"stage",
	"stash",
	"submodule",
	"switch",
	"tag",
	"update-ref",
	"worktree",
]);

/** git global flags that consume the following token. */
const gitValueFlags = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

/** First non-flag token after `git`, i.e. the subcommand ("" when absent). */
export function gitSubcommand(tokens: string[]): string {
	for (let i = 1; i < tokens.length; i++) {
		const tok = tokens[i];
		if (!tok.startsWith("-")) return tok;
		if (gitValueFlags.has(tok)) i++;
	}
	return "";
}

/** Value of the last `-C <path>` global flag, if any. */
function gitDirFlag(tokens: string[]): string | undefined {
	let found: string | undefined;
	for (let i = 1; i < tokens.length; i++) {
		const tok = tokens[i];
		if (!tok.startsWith("-")) break;
		if (tok === "-C" && i + 1 < tokens.length) found = tokens[i + 1];
		if (gitValueFlags.has(tok)) i++;
	}
	return found;
}

/** A directory path is only usable when it has no shell expansion in it. */
function isStaticPath(path: string): boolean {
	return !/[$`*?~]/.test(path);
}

/** Resolve `path` against `cwd`; undefined means "cannot be determined". */
function resolveDir(cwd: string | undefined, path: string | undefined): string | undefined {
	if (!path || !isStaticPath(path)) return undefined;
	if (isAbsolute(path)) return resolve(path);
	if (!cwd) return undefined;
	return resolve(cwd, path);
}

/**
 * Quoted strings hide whole commands from the segment splitter, so they are
 * handled before it: a quote passed to `sh -c` is scanned on its own, and a
 * quote passed to a remote executor is dropped. Everything else stays.
 *
 * Returns the command with those quotes removed plus the writes found inside.
 */
function extractQuotedCommands(
	command: string,
	baseCwd: string | undefined,
	depth: number,
): { rest: string; writes: GitWrite[] } {
	const writes: GitWrite[] = [];
	const rest = command.replace(/'([^']*)'|"([^"]*)"/g, (match, single, double, offset: number) => {
		const inner = single ?? double ?? "";
		const prefix = command.slice(0, offset);
		const lastSegment = prefix.split(new RegExp(`\\s*(?:${SHELL_OPERATORS})\\s*`)).pop() ?? "";
		const tokens = effectiveTokens(lastSegment);
		const name = tokens[0];
		if (name && REMOTE_EXECUTORS.has(name)) return "";
		if (name && SHELL_RUNNERS.has(name) && tokens.includes("-c")) {
			if (depth < 3) writes.push(...findGitWrites(inner, baseCwd, depth + 1));
			return "";
		}
		return match;
	});
	return { rest, writes };
}

export interface GitWrite {
	/** The mutating git subcommand (e.g. "commit"). */
	subcommand: string;
	/** Directory the invocation runs in, or undefined when unresolvable. */
	cwd: string | undefined;
}

/**
 * Find git invocations that modify a repository, tracking the working
 * directory across `cd`, `git -C`, and nested `bash -c` payloads.
 * Segments handed to a remote executor are skipped.
 */
export function findGitWrites(command: string, baseCwd: string | undefined, depth = 0): GitWrite[] {
	const extracted = extractQuotedCommands(command, baseCwd, depth);
	const writes: GitWrite[] = [...extracted.writes];
	const segments = extracted.rest.split(new RegExp(`\\s*(?:${SHELL_OPERATORS})\\s*`));
	let cwd = baseCwd;
	for (const segment of segments) {
		const tokens = effectiveTokens(segment);
		const name = tokens[0];
		if (!name) continue;
		if (name === "cd" || name === "pushd") {
			// `cd` with no argument, `cd -`, or an expanded path is unresolvable.
			const target = tokens.find((tok, i) => i > 0 && !tok.startsWith("-"));
			cwd = resolveDir(cwd, target);
			continue;
		}
		if (REMOTE_EXECUTORS.has(name) || SHELL_RUNNERS.has(name)) continue;
		if (name !== "git") continue;
		const subcommand = gitSubcommand(tokens);
		if (!gitWriteSubcommands.has(subcommand)) continue;
		const flagDir = gitDirFlag(tokens);
		writes.push({ subcommand, cwd: flagDir ? resolveDir(cwd, flagDir) : cwd });
	}
	return writes;
}

/** Walk up from `start` looking for a `.jj` directory or file. */
export function findJjRoot(start: string): string | undefined {
	let dir = resolve(start);
	for (;;) {
		if (existsSync(join(dir, ".jj"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
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
## Search Tool Rules
- Prefer \`pi.find\` for file discovery. Its \`pattern\` is a file glob, for example
  \`pi.find({ pattern: "*.test.ts", path: "extensions" })\`.
- Prefer \`pi.grep\` for content search. Its \`pattern\` is a regex by default;
  use \`literal: true\` for exact text containing characters such as parentheses,
  for example \`pi.grep({ pattern: "setModel(", path: "src", literal: true })\`.
  The optional \`glob\` filters file paths and does not change the content pattern.
- Only when Pi search APIs lack required options or output formatting, use
  \`pi.bash\` with quoted patterns: \`rg --fixed-strings --glob '*.ts' 'setModel('\`
  for literal content, or \`fd --glob '*.test.ts'\` for file discovery.

Version control: inside a jj (Jujutsu) repository, use \`jj\` for anything that
modifies the repository (commit, rebase, branch, reset, ...); read-only \`git\`
commands are fine. Outside a jj repository, \`git\` can be used normally.
`;

export default function (pi: ExtensionAPI) {
	// Inject substitution rules into system prompt on each turn
	pi.on("before_agent_start", async (event, _ctx) => {
		return { systemPrompt: event.systemPrompt + systemPromptAddition };
	});

	// Block git writes inside jj repos; rewrite where a clean mapping exists.
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;

		let command = (event.input.command as string) ?? "";
		const sessionCwd = ctx.cwd ?? process.cwd();

		if (findJjRoot(sessionCwd)) {
			// Auto-convert simple git commands to their jj equivalents instead of
			// blocking them (e.g. `git clone <url>` -> `jj git clone <url>`).
			const converted = command.replace(gitConvertRegex, (_m, prefix, rest) => `${prefix}jj git${rest}`);
			if (converted !== command) {
				command = converted;
				event.input.command = converted;
			}
		}

		// Block only writes whose target directory is a known jj repo.
		for (const write of findGitWrites(command, sessionCwd)) {
			if (!write.cwd) continue; // unresolvable directory: leave it alone
			const root = findJjRoot(write.cwd);
			if (!root) continue;
			return {
				block: true,
				reason: `'git ${write.subcommand}' modifies the jj repository at ${root}. Use '${replacements.git}' instead (read-only git commands are allowed).`,
			};
		}

		return undefined;
	});
}
