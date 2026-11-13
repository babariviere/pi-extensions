/**
 * Danger rules for the guardrail extension.
 *
 * Pure functions, no pi imports, so they can be unit tested directly.
 *
 * Matching is token-based, not a real shell parse. It is deliberately
 * conservative: false positives are cheap (the user can rerun in a terminal
 * or `/guardrail off`), a wiped home directory is not.
 */

import { homedir } from "node:os";
import { basename, isAbsolute, normalize, resolve } from "node:path";

export interface GuardrailContext {
	/** Home directory used to expand `~` / `$HOME`. */
	home: string;
	/** Directory relative targets are resolved against. */
	cwd: string;
}

export interface GuardrailHit {
	/** Human readable explanation shown to the model. */
	reason: string;
	/** The offending fragment of the command. */
	match: string;
}

/** Embedding hosts can enable root-search prevention without the other command rules. */
export type GuardrailScope = "all" | "root-search";

export function defaultContext(): GuardrailContext {
	return { home: homedir(), cwd: process.cwd() };
}

/** Shell tokens that start a new command position. */
const SHELL_OPERATORS = "&&|\\|\\||[|;&\\n]|\\$\\(|`";

/** Device name families whose raw nodes must never be written to. */
const RAW_DEVICE = "(?:r?disk\\d*|sd[a-z]|nvme\\d|hd[a-z]|vd[a-z]|xvd[a-z]|mmcblk\\d)";

/** Directories that should never be the direct target of a destructive command. */
const SYSTEM_DIRS = new Set([
	"/Applications",
	"/Library",
	"/System",
	"/Users",
	"/Volumes",
	"/bin",
	"/boot",
	"/dev",
	"/etc",
	"/home",
	"/lib",
	"/lib64",
	"/nix",
	"/opt",
	"/private",
	"/proc",
	"/root",
	"/sbin",
	"/srv",
	"/sys",
	"/tmp",
	"/usr",
	"/var",
]);

/**
 * Variables that are set in practice, so `rm -rf $VAR` is not the classic
 * "unset variable expands to /" footgun. `XDG_*` is covered by prefix.
 */
const SAFE_VARS = new Set(["HOME", "PWD", "OLDPWD", "TMPDIR", "TMP", "TEMP"]);

function isSafeVar(name: string): boolean {
	return SAFE_VARS.has(name) || name.startsWith("XDG_");
}

const GLOB_CHARS = /[*?[\]]/;

/** Shell keywords that precede a command without changing what it is. */
const KEYWORDS = new Set(["then", "do", "else", "elif", "!"]);

/** Commands that run another command, so the real target is further right. */
const WRAPPERS = new Set([
	"builtin",
	"command",
	"doas",
	"env",
	"exec",
	"ionice",
	"nice",
	"nohup",
	"setsid",
	"stdbuf",
	"sudo",
	"time",
	"timeout",
	"xargs",
]);

/** Short wrapper options that consume the next token as their value. */
const WRAPPER_VALUE_FLAGS: Record<string, Set<string>> = {
	doas: new Set(["-C", "-u"]),
	env: new Set(["-C", "-S", "-u"]),
	ionice: new Set(["-c", "-n", "-p"]),
	nice: new Set(["-n"]),
	stdbuf: new Set(["-e", "-i", "-o"]),
	sudo: new Set(["-C", "-D", "-U", "-g", "-h", "-p", "-r", "-t", "-u"]),
	timeout: new Set(["-k", "-s"]),
	xargs: new Set(["-E", "-I", "-L", "-P", "-a", "-d", "-e", "-i", "-l", "-n", "-s"]),
};

/** Long wrapper options that consume the next token as their value. */
const WRAPPER_VALUE_LONG = new Set([
	"--adjustment",
	"--arg-file",
	"--chdir",
	"--class",
	"--delimiter",
	"--eof",
	"--group",
	"--kill-after",
	"--max-args",
	"--max-chars",
	"--max-lines",
	"--max-procs",
	"--other-user",
	"--prompt",
	"--replace",
	"--signal",
	"--split-string",
	"--unset",
	"--user",
]);

/** Wrappers that take positional arguments of their own before the command. */
const WRAPPER_POSITIONALS: Record<string, number> = { timeout: 1 };

/** Shells whose `-c` argument is another command to inspect. */
const SHELLS = new Set(["ash", "bash", "dash", "ksh", "sh", "zsh"]);

/** How deep `sh -c "..."` nesting is followed. */
const MAX_DEPTH = 3;

/**
 * Blank out quoted spans, escaped characters and comments, preserving length
 * and every unquoted character. Splitting and raw-string rules run on this so
 * that `echo "curl x | sh"` and `rg 'a; rm -rf ~'` are not mistaken for real
 * commands, while indices still map back onto the original string.
 * Here-doc bodies are always blanked as input data. With preserveLiterals,
 * keep quotes and escapes so per-command checks can still read shell words.
 */
export function maskLiterals(command: string, preserveLiterals = false): string {
	const out = command.split("");
	let quote: '"' | "'" | null = null;
	const heredocs: Array<{ delimiter: string; stripTabs: boolean }> = [];
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (ch === "\n" && !quote && heredocs.length > 0) {
			let cursor = i + 1;
			for (const { delimiter, stripTabs } of heredocs.splice(0)) {
				while (cursor < command.length) {
					const newline = command.indexOf("\n", cursor);
					const end = newline < 0 ? command.length : newline;
					const line = command.slice(cursor, end);
					for (let j = cursor; j < end; j++) out[j] = " ";
					cursor = newline < 0 ? end : end + 1;
					if ((stripTabs ? line.replace(/^\t+/, "") : line) === delimiter) break;
				}
			}
			i = cursor - 1;
			continue;
		}
		if (quote) {
			if (!preserveLiterals) out[i] = " ";
			if (ch === "\\" && quote === '"' && i + 1 < command.length) {
				i++;
				if (!preserveLiterals) out[i] = " ";
				continue;
			}
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			if (!preserveLiterals) out[i] = " ";
			continue;
		}
		if (ch === "\\") {
			// Keep the escaped character (so `\rm` still reads as `rm`), drop the
			// backslash so it cannot look like a separator.
			if (!preserveLiterals) out[i] = " ";
			i++;
			continue;
		}
		if (ch === "<" && command[i + 1] === "<" && command[i - 1] !== "<" && command[i + 2] !== "<") {
			const header = command.slice(i + 2).match(/^(-?)[ \t]*((?:[^\s<>|;&()'"\\]+|'[^']*'|"[^"]*"|\\[^\n])+)/);
			if (header) heredocs.push({ delimiter: tokenize(header[2])[0], stripTabs: header[1] === "-" });
		}
		if (ch === "#" && (i === 0 || /\s/.test(command[i - 1]))) {
			while (i < command.length && command[i] !== "\n") out[i++] = " ";
			i--;
		}
	}
	return out.join("");
}

/**
 * Split a command into segments, one per command position. Separators inside
 * quotes do not split, since they are data, not shell syntax.
 */
function splitSegments(command: string): string[] {
	const masked = maskLiterals(command);
	const shell = maskLiterals(command, true);
	const separators = new RegExp(`(?:${SHELL_OPERATORS})`, "g");
	const segments: string[] = [];
	let last = 0;
	for (const match of masked.matchAll(separators)) {
		segments.push(shell.slice(last, match.index));
		last = match.index + match[0].length;
	}
	segments.push(shell.slice(last));
	return segments.filter((segment) => segment.trim().length > 0);
}

/** Tokenize a segment, honoring simple single/double quoting and backslash escapes. */
export function tokenize(segment: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let started = false;
	let quote: '"' | "'" | null = null;

	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i];
		if (quote) {
			if (ch === quote) {
				quote = null;
				continue;
			}
			if (ch === "\\" && quote === '"' && i + 1 < segment.length) {
				current += segment[++i];
				continue;
			}
			current += ch;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			started = true;
			continue;
		}
		if (ch === "\\" && i + 1 < segment.length) {
			current += segment[++i];
			started = true;
			continue;
		}
		if (/\s/.test(ch)) {
			if (started || current) tokens.push(current);
			current = "";
			started = false;
			continue;
		}
		current += ch;
		started = true;
	}
	if (started || current) tokens.push(current);
	return tokens;
}

interface Command {
	/** Command name with any directory prefix stripped (`/bin/rm` -> `rm`). */
	name: string;
	/** Wrapper commands that were looked through to reach it (`sudo`, `xargs`, ...). */
	wrappers: string[];
	/** Everything after the command name. */
	args: string[];
}

/**
 * Resolve the effective command of a segment, looking past shell keywords and
 * grouping, leading env assignments, and wrapper commands together with their
 * option values (`sudo -u root rm ...` is still an `rm`).
 */
function parseCommand(segment: string): Command | null {
	const tokens = tokenize(segment);
	const wrappers: string[] = [];
	let i = 0;

	for (;;) {
		if (i >= tokens.length) return null;
		const token = tokens[i].replace(/^[({!]+/, "");
		if (!token) {
			i++;
			continue;
		}
		if (KEYWORDS.has(token) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
			i++;
			continue;
		}
		const name = basename(token);
		if (!WRAPPERS.has(name)) return { name, wrappers, args: tokens.slice(i + 1) };

		wrappers.push(name);
		i++;
		while (i < tokens.length && tokens[i].startsWith("-") && tokens[i].length > 1) {
			const flag = tokens[i++];
			const takesValue = WRAPPER_VALUE_FLAGS[name]?.has(flag) || WRAPPER_VALUE_LONG.has(flag);
			if (takesValue) i++;
		}
		i += WRAPPER_POSITIONALS[name] ?? 0;
	}
}

/** Split args into flag letters (short clusters expanded) and positional operands. */
function splitArgs(args: string[]): { flags: Set<string>; operands: string[] } {
	const flags = new Set<string>();
	const operands: string[] = [];
	let noMoreFlags = false;
	for (const arg of args) {
		if (!noMoreFlags && arg === "--") {
			noMoreFlags = true;
			continue;
		}
		if (!noMoreFlags && arg.startsWith("--")) {
			flags.add(arg);
			continue;
		}
		if (!noMoreFlags && arg.startsWith("-") && arg.length > 1) {
			for (const letter of arg.slice(1)) flags.add(`-${letter}`);
			continue;
		}
		operands.push(arg);
	}
	return { flags, operands };
}

/** Search options whose following argument is data, not a search directory. */
const FD_VALUE_FLAGS = new Set([
	"-d",
	"--max-depth",
	"--min-depth",
	"--exact-depth",
	"-t",
	"--type",
	"-e",
	"--extension",
	"-E",
	"--exclude",
	"-j",
	"--threads",
	"-S",
	"--size",
	"--changed-within",
	"--changed-before",
	"--newer",
	"--older",
	"--owner",
	"--format",
	"--path-separator",
	"--max-results",
	"--ignore-file",
	"--color",
	"-c",
]);

/** Detect explicit root searches without mistaking find predicates or fd option values for paths. */
function searchesRoot(cmd: Command, ctx: GuardrailContext): boolean {
	const isRoot = (arg: string, context = ctx) => expand(arg.replace(/[);}]+$/, ""), context) === "/";
	if (cmd.name === "find") {
		let hasPath = false;
		for (let i = 0; i < cmd.args.length; i++) {
			const arg = cmd.args[i];
			if (["-H", "-L", "-P", "-X", "-d", "--"].includes(arg)) continue;
			if (arg === "-f") {
				hasPath = true;
				if (cmd.args[i + 1] && isRoot(cmd.args[++i])) return true;
				continue;
			}
			// Expressions start here. A slash in '-name /' is not a search root.
			if (arg.startsWith("-") || arg === "!" || arg === "(") break;
			hasPath = true;
			if (isRoot(arg)) return true;
		}
		return !hasPath && isRoot(".");
	}

	let positional = 0;
	let endOptions = false;
	const paths: string[] = [];
	let base = ctx;
	for (let i = 0; i < cmd.args.length; i++) {
		const arg = cmd.args[i];
		if (!endOptions && arg === "--") {
			endOptions = true;
			continue;
		}
		if (!endOptions && (arg === "-x" || arg === "--exec" || arg === "-X" || arg === "--exec-batch")) break;
		if (!endOptions && (arg === "--search-path" || arg.startsWith("--search-path="))) {
			const path = arg === "--search-path" ? cmd.args[++i] : arg.slice("--search-path=".length);
			if (path) paths.push(path);
			continue;
		}
		if (!endOptions && (arg === "--base-directory" || arg.startsWith("--base-directory="))) {
			const path = arg === "--base-directory" ? cmd.args[++i] : arg.slice("--base-directory=".length);
			if (path) base = { ...ctx, cwd: expand(path, ctx) };
			continue;
		}
		if (!endOptions && FD_VALUE_FLAGS.has(arg)) {
			i++;
			continue;
		}
		if (!endOptions && arg.startsWith("-")) continue;
		// The first positional is fd's pattern, not a path. Still reject the
		// common 'fd /' mistake, as well as actual root search directories.
		if (positional++ === 0) {
			if (/^[/]+$/u.test(arg.replace(/[);}]+$/, ""))) return true;
		} else {
			paths.push(arg);
		}
	}
	return (paths.length ? paths : ["."]).some((path) => isRoot(path, base));
}

function hasFlag(flags: Set<string>, ...names: string[]): boolean {
	return names.some((name) => flags.has(name));
}

/** Expand `~`, `$HOME` and `${HOME}` prefixes, then resolve against cwd. */
function expand(target: string, ctx: GuardrailContext): string {
	let t = target;
	if (t === "~" || t.startsWith("~/")) t = ctx.home + t.slice(1);
	else t = t.replace(/^\$\{?HOME\}?(?=$|\/)/, ctx.home);
	if (!isAbsolute(t)) t = resolve(ctx.cwd, t);
	t = normalize(t);
	if (t.length > 1 && t.endsWith("/")) t = t.slice(0, -1);
	return t;
}

/**
 * Classify a destructive command's target. Returns a noun phrase describing
 * the danger, or null when the target looks ordinary.
 */
function classifyTarget(target: string, ctx: GuardrailContext): string | null {
	const cleaned = target.replace(/[);}]+$/, "");
	if (!cleaned) return null;

	// `rm -rf $DIR` / `rm -rf $DIR/build` wipe `/` when the variable is unset.
	const variable = cleaned.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?(\/.*)?$/);
	if (variable && !isSafeVar(variable[1])) {
		const name = `$${variable[1]}`;
		return variable[2]
			? `a path under the bare variable '${name}', which resolves under '/' when it is unset`
			: `the bare variable '${name}', which expands to '/' when it is unset`;
	}

	const expanded = expand(cleaned, ctx);

	if (GLOB_CHARS.test(expanded)) {
		// Look at the directory the wildcard expands inside of.
		const globIndex = expanded.search(GLOB_CHARS);
		const slash = expanded.lastIndexOf("/", globIndex);
		const parent = slash <= 0 ? "/" : expanded.slice(0, slash);
		if (parent === "/") return "a wildcard directly under the filesystem root";
		if (parent === ctx.home) return "a wildcard directly inside your home directory";
		if (SYSTEM_DIRS.has(parent)) return `a wildcard directly inside the system directory '${parent}'`;
		return null;
	}

	if (expanded === "/") return "the filesystem root";
	if (expanded === ctx.home) return "your home directory";
	if (SYSTEM_DIRS.has(expanded)) return `the system directory '${expanded}'`;
	if (/\/\.(git|jj)$/.test(expanded)) return `repository metadata ('${expanded}')`;
	return null;
}

/** Interpreters with direct-edit restrictions. Python programs are intentionally allowed. */
const PERL_INTERPRETER = /^perl(?:\d+(?:\.\d+)*)?$/;
const AWK_INTERPRETER = /^(?:awk|gawk|mawk|nawk)$/;

function hasOption(args: string[], predicate: (arg: string) => boolean): boolean {
	for (const arg of args) {
		if (arg === "--") return false;
		if (predicate(arg)) return true;
		if (!arg.startsWith("-") || arg === "-") return false;
	}
	return false;
}

function readsProgramFromStdin(args: string[]): boolean {
	if (args.length === 0) return true;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") return args[i + 1] === undefined || args[i + 1] === "-";
		if (arg === "-" || arg.startsWith("<<")) return true;
		if (arg === "-W" || arg === "-X") {
			i++;
			continue;
		}
		if (/^(?:-h|--help|-V|--version)$/.test(arg)) return false;
		if (!arg.startsWith("-")) return false;
	}
	return true;
}

function awkInlineProgram(args: string[]): string | undefined {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") return args[i + 1];
		if (arg === "-f" || arg === "--file") return undefined;
		if (arg === "-v" || arg === "-F") {
			i++;
			continue;
		}
		if (arg.startsWith("-")) continue;
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) continue;
		return arg;
	}
	return undefined;
}

/** Find shell output redirects whose destination is a file rather than an fd or /dev/null. */
function checkFileRedirect(command: string, masked: string): GuardrailHit | null {
	const redirect = /(^|[^<>=&])(?:\d+|\{[A-Za-z_][A-Za-z0-9_]*\})?(?:&>>|&>|>>|>\||<>|>)(?![>&(=])/g;
	for (const match of masked.matchAll(redirect)) {
		const operatorStart = match.index + match[1].length;
		const operatorText = command.slice(operatorStart, match.index + match[0].length);
		// The destination word ends at the first unquoted separator, so
		// `> /dev/null; done` still reads as `/dev/null` rather than `/dev/null;`.
		// Quoted spans are blank in the mask, keeping separators inside them inert.
		let end = match.index + match[0].length;
		while (end < masked.length && !/[;|&()`]/.test(masked[end])) end++;
		const target = tokenize(command.slice(match.index + match[0].length, end))[0];
		const normalizedTarget = target && isAbsolute(target) ? normalize(target) : undefined;
		const isLiteralTmpFile = normalizedTarget?.startsWith("/tmp/") && !/[\$`*?[\]{}()]/.test(target);
		const tmpdirRelative = target?.match(/^\$(?:TMPDIR|\{TMPDIR\})\/(.+)$/)?.[1];
		const isTmpdirFile =
			tmpdirRelative !== undefined &&
			normalize(`/tmp/${tmpdirRelative}`).startsWith("/tmp/") &&
			!/[\$`*?[\]{}()]/.test(tmpdirRelative);
		if (!target || /^&(?:\d+|-)$/.test(target) || target === "/dev/null" || isLiteralTmpFile || isTmpdirFile)
			continue;
		return {
			reason: "shell output redirection writing directly to a file; use the write or edit tool instead",
			match: `${operatorText}${JSON.stringify(target)}`,
		};
	}
	return null;
}

/**
 * Rules evaluated on the whole command: pipelines, redirects, fork bombs.
 * Matching runs on the masked string so quoted text and comments are inert,
 * while the reported fragment comes from the original.
 */
function checkRaw(command: string, masked: string): GuardrailHit | null {
	const patterns: Array<{ regex: RegExp; reason: string }> = [
		{ regex: /:\s*\(\s*\)\s*\{[^{}]{0,200}\|[^{}]{0,200}\}\s*;?\s*:/, reason: "fork bomb" },
		{
			regex: /\b(?:curl|wget)\b[^|\n]{0,400}\|\s*(?:(?:sudo|doas)(?:\s+-\S+){0,5}\s+)?(?:ba|z|k|da)?sh\b/,
			reason: "piping a download straight into a shell; download it, read it, then run it",
		},
		{ regex: new RegExp(`>\\s*/dev/${RAW_DEVICE}\\S*`), reason: "redirecting output onto a raw block device" },
	];
	for (const { regex, reason } of patterns) {
		const match = regex.exec(masked);
		if (match) return { reason, match: command.slice(match.index, match.index + match[0].length) };
	}
	return checkFileRedirect(command, masked);
}

/** Rules evaluated per command in the pipeline. */
function checkCommandSegment(
	segment: string,
	ctx: GuardrailContext,
	depth: number,
	scope: GuardrailScope,
): GuardrailHit | null {
	const cmd = parseCommand(segment);
	if (!cmd) return null;
	if (scope === "root-search" && !["find", "fd", "fdfind"].includes(cmd.name) && !SHELLS.has(cmd.name)) return null;
	const { flags, operands } = splitArgs(cmd.args);
	const hit = (reason: string): GuardrailHit => ({ reason, match: segment.trim() });

	if (
		PERL_INTERPRETER.test(cmd.name) &&
		(hasOption(cmd.args, (arg) => /^-[^-]*[eE]/.test(arg)) || readsProgramFromStdin(cmd.args))
	) {
		return hit(`inline '${cmd.name}' program; use the write or edit tool instead`);
	}
	if (cmd.name === "sed" && hasOption(cmd.args, (arg) => arg === "--in-place" || /^-[^-]*i/.test(arg))) {
		return hit("'sed' in-place edit; use the edit tool instead");
	}
	if (cmd.name === "tee") {
		const fileOperands = operands.filter((operand) => operand !== "-" && operand !== "/dev/null");
		if (fileOperands.length > 0) return hit("'tee' writing directly to a file; use the write or edit tool instead");
	}
	if (AWK_INTERPRETER.test(cmd.name)) {
		if (hasOption(cmd.args, (arg) => arg === "--in-place" || arg === "-i" || arg.startsWith("-i"))) {
			return hit(`'${cmd.name}' in-place edit; use the edit tool instead`);
		}
		const program = awkInlineProgram(cmd.args);
		if (program && /\b(?:print|printf)\b[^;\n{}]*>{1,2}/.test(program)) {
			return hit(`inline '${cmd.name}' program writing directly to a file`);
		}
	}

	if (SHELLS.has(cmd.name) && depth < MAX_DEPTH) {
		const index = cmd.args.findIndex((arg) => arg === "-c" || /^-[a-zA-Z]*c$/.test(arg));
		const inner = index >= 0 ? cmd.args[index + 1] : undefined;
		if (inner) {
			const nested = checkCommand(inner, ctx, depth + 1, scope);
			if (nested) return { reason: nested.reason, match: segment.trim() };
		}
		return null;
	}

	switch (cmd.name) {
		case "find":
		case "fd":
		case "fdfind":
			return searchesRoot(cmd, ctx)
				? hit(`'${cmd.name}' searching the filesystem root; choose a project or a specific directory instead`)
				: null;
		case "rm": {
			for (const operand of operands) {
				const why = classifyTarget(operand, ctx);
				if (why) return hit(`'rm' targeting ${why}`);
			}
			// `xargs rm -rf` legitimately has no operand: it comes from stdin.
			const fromStdin = cmd.wrappers.includes("xargs");
			if (!fromStdin && operands.length === 0 && hasFlag(flags, "-r", "-R", "--recursive")) {
				return hit("'rm -r' with no target");
			}
			return null;
		}
		case "chmod":
		case "chown":
		case "chgrp": {
			if (!hasFlag(flags, "-R", "-r", "--recursive")) return null;
			for (const operand of operands.slice(1)) {
				const why = classifyTarget(operand, ctx);
				if (why) return hit(`recursive '${cmd.name}' on ${why}`);
			}
			return null;
		}
		case "dd": {
			const out = cmd.args.find((arg) => arg.startsWith("of="));
			if (out && new RegExp(`^of=/dev/${RAW_DEVICE}`).test(out)) {
				return hit(`'dd' writing to the raw device '${out.slice(3)}'`);
			}
			return null;
		}
		case "shutdown":
		case "reboot":
		case "halt":
		case "poweroff":
			return hit(`'${cmd.name}' would take the machine down`);
		case "systemctl": {
			if (operands.some((op) => /^(poweroff|reboot|halt|kexec)$/.test(op))) {
				return hit("'systemctl' would take the machine down");
			}
			return null;
		}
		case "init":
		case "telinit": {
			if (operands.some((op) => op === "0" || op === "6")) return hit(`'${cmd.name}' would take the machine down`);
			return null;
		}
		case "diskutil": {
			if (operands.some((op) => /^(eraseDisk|eraseVolume|partitionDisk|zeroDisk)$/i.test(op))) {
				return hit("'diskutil' erase/partition operation");
			}
			return null;
		}
		default: {
			if (/^mkfs(\.|$)/.test(cmd.name)) return hit(`'${cmd.name}' formats a filesystem`);
			return null;
		}
	}
}

/** Check a literal argv call without treating its arguments as shell syntax. */
export function checkArgv(
	argv: string[],
	ctx: GuardrailContext = defaultContext(),
	scope: GuardrailScope = "all",
): GuardrailHit | null {
	if (argv.length === 0) return null;
	const quoted = argv.map((arg) => `'${arg.replaceAll("'", `'\\''`)}'`).join(" ");
	return checkCommand(quoted, ctx, 0, scope);
}

/**
 * Check a bash command for obviously destructive operations.
 * Returns null when nothing suspicious was found.
 */
export function checkCommand(
	command: string,
	ctx: GuardrailContext = defaultContext(),
	depth = 0,
	scope: GuardrailScope = "all",
): GuardrailHit | null {
	if (!command.trim()) return null;
	const raw = scope === "all" ? checkRaw(command, maskLiterals(command)) : null;
	if (raw) return raw;
	for (const segment of splitSegments(command)) {
		const hit = checkCommandSegment(segment, ctx, depth, scope);
		if (hit) return hit;
	}
	return null;
}
