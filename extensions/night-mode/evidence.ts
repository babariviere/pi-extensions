/**
 * Structured evidence for a night ledger closure, and the checks that decide
 * whether the claim holds.
 *
 * The night ledger is a list of todos (see `ledger.ts`), and closing one used to
 * mean writing the word `done` in the front matter and remembering to add a
 * prose `Evidence:` line. Four nights of reports say that is not enough: items
 * were closed with no evidence at all and carried over as if abandoned, and one
 * item was closed with a file path that did not exist, which then travelled into
 * the report as a link to nothing.
 *
 * So evidence is typed (`file`, `commit`, `command`, `pr`, `url`,
 * `none-with-reason`), required at write time, and verified rather than
 * believed. Reading stays lenient: a todo written before any of this still
 * loads, and its prose evidence is kept as `unstructured` rather than rewritten
 * or rejected. Only new closures are held to the format.
 *
 * Every kind except `command` points at an artifact, which only shows that
 * something was produced. `command` is a predicate the claim has to survive:
 * the check is re-run at verification time and the item is demoted unless it
 * exits 0. That is the difference between "a file exists" and "the tests that
 * were supposed to pass still pass".
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

/** Kinds a closure may claim. Each one has a matching check in `verifyEvidence`. */
export const EVIDENCE_KINDS = ["file", "commit", "command", "pr", "url", "none-with-reason"] as const;

export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/**
 * Evidence that predates the typed format: prose whose shape says nothing.
 * Accepted on read for backward compatibility, never accepted on write.
 */
export const UNSTRUCTURED = "unstructured";

export type ParsedEvidenceKind = EvidenceKind | typeof UNSTRUCTURED;

export interface Evidence {
	kind: ParsedEvidenceKind;
	/** Path, revision, shell command, URL or reason, depending on the kind. */
	value: string;
	/** Directory a `commit` resolves in, or a `command` runs in. Defaults to the run's working copy. */
	repo?: string;
	/** The `Evidence:` line as written, for reporting. */
	raw: string;
}

/** Statuses that claim the work is finished. */
export const CLOSED_STATUSES = ["closed", "done", "completed"];

/** Statuses that claim the work was deliberately dropped. */
export const SKIPPED_STATUSES = ["skipped", "blocked", "wontfix", "cancelled", "canceled"];

export function isClosedStatus(status: string): boolean {
	return CLOSED_STATUSES.includes(status.trim().toLowerCase());
}

export function isSkippedStatus(status: string): boolean {
	return SKIPPED_STATUSES.includes(status.trim().toLowerCase());
}

/** First non-empty `Label: value` line in a body, case insensitive. */
export function readField(body: string, label: string): string | undefined {
	const pattern = new RegExp(`^\\s*(?:[-*]\\s*)?(?:\\*\\*)?${label}(?:\\*\\*)?\\s*:\\s*(.+)$`, "im");
	const match = pattern.exec(body);
	const value = match?.[1]?.trim();
	return value ? value : undefined;
}

const KIND_PATTERN = new RegExp(`^(${EVIDENCE_KINDS.join("|")})\\s*[:=]?\\s+(.+)$`, "i");
const PR_PATH = /\/(pull|pulls|pull-requests|merge_requests)\/\d+/i;
const HEX_REVISION = /^[0-9a-f]{7,40}$/i;
/** jj change ids use the reversed hex alphabet. */
const CHANGE_ID = /^[k-z]{8,32}$/;

/**
 * Guess the kind of a line written before the typed format existed. Only
 * shapes that are unambiguous count; anything else stays `unstructured`, which
 * verification then skips instead of failing on.
 */
function inferKind(value: string): EvidenceKind | undefined {
	if (/^https?:\/\//i.test(value)) return PR_PATH.test(value) ? "pr" : "url";
	if (value.startsWith("/") || value.startsWith("~/")) return "file";
	if (HEX_REVISION.test(value) || CHANGE_ID.test(value)) return "commit";
	return undefined;
}

/**
 * Parse the value of an `Evidence:` line.
 *
 * Accepted forms, in order of preference:
 *   `file /abs/path`
 *   `commit 069262f8 (repo: /src/phishing)`
 *   `command npm test -- parser (repo: /src/phishing)`
 *   `pr https://github.com/o/r/pull/12`
 *   `none-with-reason no egress tonight, so no PR could be opened`
 * and, for files written before the format existed, a bare path/URL/revision.
 */
export function parseEvidenceValue(raw: string, repoField?: string): Evidence | undefined {
	const trimmed = raw.trim();
	if (!trimmed) return undefined;

	let rest = trimmed;
	let repo = repoField?.trim() || undefined;
	const inlineRepo = /\(\s*repo\s*:\s*([^)]+)\)\s*$/i.exec(rest);
	if (inlineRepo) {
		repo = inlineRepo[1].trim();
		rest = rest.slice(0, inlineRepo.index).trim();
	}

	const kindMatch = KIND_PATTERN.exec(rest);
	const value = (kindMatch ? kindMatch[2] : rest).trim();
	if (!value) return undefined;
	const kind = kindMatch ? (kindMatch[1].toLowerCase() as EvidenceKind) : (inferKind(value) ?? UNSTRUCTURED);
	return { kind, value, ...(repo ? { repo } : {}), raw: trimmed };
}

/** The evidence a todo body carries, if any. */
export function parseEvidence(body: string): Evidence | undefined {
	const line = readField(body, "evidence");
	if (!line) return undefined;
	return parseEvidenceValue(line, readField(body, "repo"));
}

/** The canonical line to write into a todo body. */
export function formatEvidenceLine(evidence: Evidence): string {
	const repo = evidence.repo ? ` (repo: ${evidence.repo})` : "";
	return `Evidence: ${evidence.kind} ${evidence.value}${repo}`;
}

/** What a rejected close is told to write instead. */
export const EVIDENCE_FORMAT_HELP =
	"Use one of: `Evidence: file /abs/path`, `Evidence: commit <change-or-commit-id> (repo: /abs/repo)`, " +
	"`Evidence: command <shell check that exits 0> (repo: /abs/repo)`, " +
	"`Evidence: pr https://github.com/owner/repo/pull/1`, `Evidence: url https://...`, " +
	"`Evidence: none-with-reason <why there is nothing to point at>`. " +
	"Prefer `command` when the claim is about behaviour: it is re-run at verification time.";

/**
 * Commands that pass no matter what the night did. Accepting one would let an
 * item certify itself, which is the failure the typed format exists to stop.
 */
const NO_OP_COMMANDS = /^(?:true|:|exit\s+0|echo\b.*|printf\b.*|\/bin\/true)$/i;

export type ClosureCheck = { ok: true; evidence?: Evidence; reason?: string } | { ok: false; error: string };

/**
 * Whether a night ledger item may be written with this status and body.
 *
 * Enforced where the todo is written, not where it is read: an item that never
 * reaches disk in a bad state cannot mislead the next night. `done` needs typed
 * evidence, `skipped` needs a reason, everything else is free.
 */
export function validateClosure(input: { status: string; body: string }): ClosureCheck {
	const status = input.status.trim().toLowerCase();
	const body = input.body ?? "";

	if (isSkippedStatus(status)) {
		const reason = readField(body, "reason");
		if (!reason) {
			return {
				ok: false,
				error:
					`A night ledger item cannot be '${status}' without a reason. ` +
					"Add a `Reason: <why this was dropped>` line to the todo body.",
			};
		}
		return { ok: true, reason };
	}

	if (!isClosedStatus(status)) return { ok: true };

	const evidence = parseEvidence(body);
	if (!evidence) {
		return {
			ok: false,
			error: `A night ledger item cannot be '${status}' without evidence. ${EVIDENCE_FORMAT_HELP}`,
		};
	}
	if (evidence.kind === UNSTRUCTURED) {
		return {
			ok: false,
			error: `Evidence "${evidence.value}" has no recognisable kind, so nothing can check it. ${EVIDENCE_FORMAT_HELP}`,
		};
	}
	if (evidence.kind === "none-with-reason" && evidence.value.length < 8) {
		return { ok: false, error: "`none-with-reason` needs an actual reason, not a placeholder." };
	}
	if (evidence.kind === "command" && NO_OP_COMMANDS.test(evidence.value.trim())) {
		return {
			ok: false,
			error: `"${evidence.value}" passes whatever the night did, so it proves nothing. Use a check that fails when the work is undone.`,
		};
	}
	return { ok: true, evidence };
}

export interface Verification {
	ok: boolean;
	/** Why it passed or failed, short enough for a report line. */
	detail: string;
}

/** The outcome of replaying a `command` evidence check. */
export interface CommandOutcome {
	exitCode: number | null;
	/** Tail of the combined output, bounded for reporting. */
	output: string;
	error?: string;
}

export interface VerifyOptions {
	/** Base for relative paths and default directory for `commit` and `command`. */
	cwd?: string;
	/** Injected for tests. `undefined` means the path does not exist. */
	statPath?: (path: string) => { size: number } | undefined;
	/** Injected for tests. Returns false when the revision does not resolve. */
	resolveCommit?: (revision: string, repo: string) => boolean;
	/** Injected for tests. Replays a `command` evidence check. */
	runCommand?: (command: string, cwd: string, timeoutMs: number) => CommandOutcome;
	/** Per-command ceiling. A check that needs longer than this is not a check. */
	commandTimeoutMs?: number;
	/** Injected for tests. Clock behind the replay cache. */
	now?: () => number;
	/**
	 * Set false to report `command` evidence unchecked instead of running it.
	 * The commands come from the night's own todos, so they carry the authority
	 * of whoever verifies; a caller that does not want that says so here.
	 */
	runCommands?: boolean;
}

/** Long enough for a test suite, short enough that a wedged check still reports. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 300_000;

/**
 * How long a replayed check's verdict is reused.
 *
 * The ledger is re-read and re-verified on every nudge tick, on `/night status`
 * and at run end, so an uncached `command` kind would re-run every suite in the
 * ledger every few minutes. The window is short enough that a check which starts
 * failing is noticed within one report cycle.
 */
export const COMMAND_CACHE_TTL_MS = 5 * 60_000;

const COMMAND_OUTPUT_MAX_CHARS = 2_000;

const commandCache = new Map<string, { at: number; outcome: CommandOutcome }>();

/** Drop memoized command verdicts (run boundaries and tests). */
export function clearEvidenceCommandCache(): void {
	commandCache.clear();
}

function expandPath(value: string, cwd: string): string {
	const expanded = value.startsWith("~/") ? resolve(homedir(), value.slice(2)) : value;
	return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

/**
 * Size of a path, or undefined when it does not exist. A directory reports its
 * entry count, so an empty deliverable directory fails like an empty file.
 */
const defaultStatPath = (path: string): { size: number } | undefined => {
	try {
		if (!existsSync(path)) return undefined;
		const stats = statSync(path);
		return { size: stats.isDirectory() ? readdirSync(path).length : stats.size };
	} catch {
		return undefined;
	}
};

/**
 * `jj show` in the named repository. No network: a change that only exists
 * locally is still evidence, since a night with no egress cannot push.
 */
const defaultResolveCommit = (revision: string, repo: string): boolean => {
	try {
		execFileSync("jj", ["--ignore-working-copy", "show", "--summary", revision], {
			cwd: repo,
			stdio: "ignore",
			timeout: 15_000,
		});
		return true;
	} catch {
		return false;
	}
};

/**
 * Run a check through the shell, like the night itself would. Combined output
 * is captured and bounded: the report needs the reason it failed, not the log.
 */
const defaultRunCommand = (command: string, cwd: string, timeoutMs: number): CommandOutcome => {
	const result = spawnSync(command, {
		cwd,
		shell: true,
		timeout: timeoutMs,
		encoding: "utf-8",
		maxBuffer: 8 * 1024 * 1024,
	});
	const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
	const output = combined.length > COMMAND_OUTPUT_MAX_CHARS ? combined.slice(-COMMAND_OUTPUT_MAX_CHARS) : combined;
	return {
		exitCode: result.status,
		output,
		...(result.error ? { error: result.error.message } : {}),
	};
};

const memoizedRun = (
	runCommand: NonNullable<VerifyOptions["runCommand"]>,
	command: string,
	cwd: string,
	timeoutMs: number,
	now: () => number,
): CommandOutcome => {
	const key = `${cwd}\u0000${command}`;
	const cached = commandCache.get(key);
	const at = now();
	if (cached && at - cached.at <= COMMAND_CACHE_TTL_MS) return cached.outcome;
	const outcome = runCommand(command, cwd, timeoutMs);
	commandCache.set(key, { at, outcome });
	return outcome;
};

/** The bit of command output worth putting on a report line. */
const lastLine = (output: string): string => {
	const lines = output.split("\n").filter((line) => line.trim());
	return lines[lines.length - 1]?.trim() ?? "";
};

function verifyUrl(value: string): URL | undefined {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Check a claim. Never touches the network (a night run has none), so a `pr` is
 * only checked for shape.
 */
export function verifyEvidence(evidence: Evidence, opts: VerifyOptions = {}): Verification {
	const cwd = opts.cwd ?? process.cwd();
	const statPath = opts.statPath ?? defaultStatPath;
	const resolveCommit = opts.resolveCommit ?? defaultResolveCommit;

	switch (evidence.kind) {
		case "file": {
			const path = expandPath(evidence.value, cwd);
			const stats = statPath(path);
			if (!stats) return { ok: false, detail: `file does not exist: ${path}` };
			if (stats.size <= 0) return { ok: false, detail: `file is empty: ${path}` };
			return { ok: true, detail: `file exists (${stats.size} bytes): ${path}` };
		}
		case "commit": {
			const repo = expandPath(evidence.repo ?? cwd, cwd);
			if (!resolveCommit(evidence.value, repo)) {
				return { ok: false, detail: `revision ${evidence.value} does not resolve in ${repo}` };
			}
			return { ok: true, detail: `revision ${evidence.value} resolves in ${repo}` };
		}
		case "command": {
			if (opts.runCommands === false) {
				return { ok: true, detail: `command not replayed by request: ${evidence.value}` };
			}
			const timeoutMs = opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
			const runCommand = opts.runCommand ?? defaultRunCommand;
			const where = expandPath(evidence.repo ?? cwd, cwd);
			const outcome = memoizedRun(runCommand, evidence.value, where, timeoutMs, opts.now ?? Date.now);
			if (outcome.error !== undefined) {
				return { ok: false, detail: `command did not run in ${where}: ${outcome.error}` };
			}
			if (outcome.exitCode !== 0) {
				const tail = lastLine(outcome.output);
				const exit = outcome.exitCode === null ? "was killed (timeout?)" : `exited ${outcome.exitCode}`;
				return {
					ok: false,
					detail: `command ${exit} in ${where}: ${evidence.value}${tail ? ` — ${tail}` : ""}`,
				};
			}
			return { ok: true, detail: `command exited 0 in ${where}: ${evidence.value}` };
		}
		case "pr": {
			const url = verifyUrl(evidence.value);
			if (!url) return { ok: false, detail: `not an http(s) URL: ${evidence.value}` };
			if (!PR_PATH.test(url.pathname)) {
				return { ok: false, detail: `not a pull request URL: ${evidence.value}` };
			}
			return { ok: true, detail: `well-formed pull request URL (not fetched): ${url.href}` };
		}
		case "url": {
			const url = verifyUrl(evidence.value);
			if (!url) return { ok: false, detail: `not an http(s) URL: ${evidence.value}` };
			return { ok: true, detail: `well-formed URL (not fetched): ${url.href}` };
		}
		case "none-with-reason":
			return evidence.value.length >= 8
				? { ok: true, detail: `nothing to point at: ${evidence.value}` }
				: { ok: false, detail: "`none-with-reason` carries no actual reason" };
		default:
			// Written before the typed format: believed, but said out loud.
			return { ok: true, detail: "unstructured evidence, not checked" };
	}
}
