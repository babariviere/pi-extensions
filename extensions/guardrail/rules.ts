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
 */
export function maskLiterals(command: string): string {
	const out = command.split("");
	let quote: '"' | "'" | null = null;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote) {
			out[i] = " ";
			if (ch === "\\" && quote === '"' && i + 1 < command.length) {
				out[++i] = " ";
				continue;
			}
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			out[i] = " ";
			continue;
		}
		if (ch === "\\") {
			// Keep the escaped character (so `\rm` still reads as `rm`), drop the
			// backslash so it cannot look like a separator.
			out[i] = " ";
			i++;
			continue;
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
	const separators = new RegExp(`(?:${SHELL_OPERATORS})`, "g");
	const segments: string[] = [];
	let last = 0;
	for (const match of masked.matchAll(separators)) {
		segments.push(command.slice(last, match.index));
		last = match.index + match[0].length;
	}
	segments.push(command.slice(last));
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
	return null;
}

/** Rules evaluated per command in the pipeline. */
function checkCommandSegment(segment: string, ctx: GuardrailContext, depth: number): GuardrailHit | null {
	const cmd = parseCommand(segment);
	if (!cmd) return null;
	const { flags, operands } = splitArgs(cmd.args);
	const hit = (reason: string): GuardrailHit => ({ reason, match: segment.trim() });

	if (SHELLS.has(cmd.name) && depth < MAX_DEPTH) {
		const index = cmd.args.findIndex((arg) => arg === "-c" || /^-[a-zA-Z]*c$/.test(arg));
		const inner = index >= 0 ? cmd.args[index + 1] : undefined;
		if (inner) {
			const nested = checkCommand(inner, ctx, depth + 1);
			if (nested) return { reason: nested.reason, match: segment.trim() };
		}
		return null;
	}

	switch (cmd.name) {
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

/**
 * Check a bash command for obviously destructive operations.
 * Returns null when nothing suspicious was found.
 */
export function checkCommand(
	command: string,
	ctx: GuardrailContext = defaultContext(),
	depth = 0,
): GuardrailHit | null {
	if (!command.trim()) return null;
	const raw = checkRaw(command, maskLiterals(command));
	if (raw) return raw;
	for (const segment of splitSegments(command)) {
		const hit = checkCommandSegment(segment, ctx, depth);
		if (hit) return hit;
	}
	return null;
}
