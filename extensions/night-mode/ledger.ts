/**
 * The night ledger: the machine-readable list of what tonight is supposed to
 * cover, so the run can be told it is not finished yet.
 *
 * Not a new file format: these are `todos` extension files, tagged `night`, so
 * the agent manages them with the todo tool it already has and this module only
 * reads and classifies. What is dedicated is the *store*: `nightMode.todoPath`,
 * default `~/.pi/agent/night/todos`. See `ledgerDir` for why it cannot be
 * derived from the cwd.
 *
 * Classification is deliberately suspicious: an item claiming to be done without
 * evidence, or skipped without a reason, counts as still pending. Otherwise the
 * cheapest way for an agent to end the night is to mark everything done.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type CapabilityEntry, latestCapabilities } from "./capability-journal.ts";
import { type NightConfig, resolvePath } from "./config.ts";
import {
	CLOSED_STATUSES,
	type Evidence,
	parseEvidence,
	readField,
	SKIPPED_STATUSES,
	type Verification,
	type VerifyOptions,
	verifyEvidence,
} from "./evidence.ts";

export { readField } from "./evidence.ts";

/** Tag that opts a todo into the night ledger. */
export const NIGHT_TAG = "night";

/** Tag prefix that binds a ledger item to one run: `run:2026-08-31-1907`. */
export const RUN_TAG_PREFIX = "run:";

/** The tag a run's items carry. */
export function runTag(runId: string): string {
	return `${RUN_TAG_PREFIX}${runId}`;
}

/**
 * Run id for a night, derived from its start. Sortable as a string, which is
 * what makes "the previous run" a `max` over the ids that are not this one.
 */
export function runIdFor(startedAt: Date): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return (
		`${startedAt.getFullYear()}-${pad(startedAt.getMonth() + 1)}-${pad(startedAt.getDate())}` +
		`-${pad(startedAt.getHours())}${pad(startedAt.getMinutes())}`
	);
}

export type LedgerState =
	/** Not started, or in flight. */
	| "pending"
	/** Closed with evidence: really done. */
	| "done"
	/** Deliberately not done, with a reason. */
	| "skipped"
	/** Claims to be resolved but carries no evidence/reason: treated as pending. */
	| "unverified"
	/** Closed with evidence that failed its check: a human has to look. */
	| "needs-review";

export interface LedgerItem {
	id: string;
	title: string;
	/** Raw todo status, kept for reporting. */
	status: string;
	state: LedgerState;
	evidence?: string;
	reason?: string;
	/** Parsed form of `evidence`, when the item claims to be done. */
	evidenceRecord?: Evidence;
	/** Result of checking `evidenceRecord`, once the item has been verified. */
	verification?: Verification;
	/** Run the item belongs to, from its `run:<id>` tag. Absent on legacy items. */
	runId?: string;
	/**
	 * Capabilities the item's plan depends on, from its `needs` field: probe ids
	 * (`loopback-tcp`, `ssh-github`, ...) or anything else the capability journal
	 * records. Declared so an item that cannot possibly finish tonight is surfaced
	 * at claim time instead of delivered half-done.
	 */
	needs?: string[];
}

/**
 * Which of an item's declared capabilities are known not to work.
 *
 * The point is to spend the discovery once. PR #6181 of 2026-09-02 is "draft,
 * incomplete by design": the rename landed but `go generate` and `task
 * dbmate-dump` could not run, because the sandbox had no local Postgres. That
 * was already in the preflight at 20:52, before the item was claimed, and it
 * still cost a review pass on a structurally unfinishable change.
 *
 * `degraded` does not block: it means slower or partial, not impossible.
 */
export function blockedCapabilities(item: LedgerItem, capabilities: CapabilityEntry[]): string[] {
	if (!item.needs || item.needs.length === 0) return [];
	const broken = new Set(
		latestCapabilities(capabilities)
			.filter((entry) => entry.state === "broken")
			.map((entry) => entry.capability),
	);
	return item.needs.filter((need) => broken.has(need));
}

/** Same resolution as `todos.ts`, so both see one store. */
export function todosDir(cwd: string): string {
	const fromEnv = process.env.PI_TODO_PATH;
	if (fromEnv?.trim()) {
		const expanded = fromEnv.startsWith("~/") ? join(homedir(), fromEnv.slice(2)) : fromEnv;
		return resolve(expanded);
	}
	return resolve(cwd, ".pi", "todos");
}

/**
 * Where a run's ledger lives.
 *
 * The ledger is run-scoped, but a cwd-derived store is not: `/night start`
 * clones the checkout and every `night: true` subagent gets its own jj workspace,
 * so `<cwd>/.pi/todos` resolves to a different directory in the coordinator, in
 * the clone, and in each child. The child's store is untracked (`.pi/` is
 * gitignored, and `jj workspace add` checks out tracked files only) and its
 * directory is removed at teardown, so evidence written there is lost and the
 * coordinator concludes the item is still open.
 *
 * So the configured path wins, and it is absolute. `todoPath: ""` opts back into
 * the cwd-derived store for anyone who wants one ledger per repository.
 */
export function ledgerDir(config: NightConfig, cwd: string): string {
	return config.todoPath ? resolvePath(config.todoPath, cwd) : todosDir(cwd);
}

/** Extract the JSON front matter object and the markdown body of a todo file. */
function splitTodo(content: string): { frontMatter: string; body: string } {
	if (!content.startsWith("{")) return { frontMatter: "", body: content };
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = 0; i < content.length; i += 1) {
		const char = content[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{") depth += 1;
		else if (char === "}") {
			depth -= 1;
			if (depth === 0) {
				return {
					frontMatter: content.slice(0, i + 1),
					body: content.slice(i + 1).replace(/^\r?\n+/, ""),
				};
			}
		}
	}
	return { frontMatter: "", body: content };
}

/**
 * Where an item really stands. Closed needs `Evidence:`, skipped needs
 * `Reason:`; anything else that claims to be resolved is `unverified` and keeps
 * counting against the run.
 */
export function classify(
	status: string,
	body: string,
): { state: LedgerState; evidence?: string; reason?: string; evidenceRecord?: Evidence } {
	const normalized = status.trim().toLowerCase();
	const evidenceRecord = parseEvidence(body);
	const evidence = evidenceRecord?.raw;
	const reason = readField(body, "reason");

	if (SKIPPED_STATUSES.includes(normalized)) {
		return reason ? { state: "skipped", reason } : { state: "unverified" };
	}
	if (CLOSED_STATUSES.includes(normalized)) {
		if (!evidence || !evidenceRecord) return { state: "unverified" };
		return { state: "done", evidence, evidenceRecord };
	}
	return { state: "pending" };
}

/** Parse one todo file into a ledger item, or undefined when it is not a night item. */
export function parseLedgerItem(id: string, content: string): LedgerItem | undefined {
	const { frontMatter, body } = splitTodo(content);
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(frontMatter || "{}") as Record<string, unknown>;
	} catch {
		return undefined;
	}
	const tags = Array.isArray(parsed.tags) ? parsed.tags.filter((t): t is string => typeof t === "string") : [];
	if (!tags.some((tag) => tag.toLowerCase() === NIGHT_TAG)) return undefined;

	const status = typeof parsed.status === "string" && parsed.status ? parsed.status : "open";
	const { state, evidence, reason, evidenceRecord } = classify(status, body);
	// `needs: "loopback-tcp, gh-auth"` or `needs: ["loopback-tcp"]`. Both, because
	// the field is typed by hand at 2am.
	const needs = Array.isArray(parsed.needs)
		? parsed.needs.filter((need): need is string => typeof need === "string")
		: typeof parsed.needs === "string"
			? parsed.needs.split(/[,\s]+/).filter(Boolean)
			: [];
	const runTagValue = tags.find((tag) => tag.toLowerCase().startsWith(RUN_TAG_PREFIX));
	const runId = runTagValue?.slice(RUN_TAG_PREFIX.length).trim();
	return {
		id: typeof parsed.id === "string" && parsed.id ? parsed.id : id,
		title: typeof parsed.title === "string" ? parsed.title : "",
		status,
		state,
		...(evidence ? { evidence } : {}),
		...(reason ? { reason } : {}),
		...(evidenceRecord ? { evidenceRecord } : {}),
		...(runId ? { runId } : {}),
		...(needs.length > 0 ? { needs } : {}),
	};
}

/**
 * Check what a `done` item claims, and demote it when the claim does not hold.
 *
 * Nothing else in a night run distinguishes "the child wrote the file" from
 * "the child said it wrote the file": the 2026-08-31 report cited a deliverable
 * that had been deleted with its workspace, because the only check was that an
 * `Evidence:` line existed. A failed check is not silently reopened either, it
 * becomes `needs-review` so the failure is reported rather than re-attempted.
 */
export function verifyItem(item: LedgerItem, opts: VerifyOptions = {}): LedgerItem {
	if (item.state !== "done" || !item.evidenceRecord) return item;
	const verification = verifyEvidence(item.evidenceRecord, opts);
	return { ...item, verification, ...(verification.ok ? {} : { state: "needs-review" as const }) };
}

/** `verifyItem` over a whole ledger. */
export function verifyLedger(items: LedgerItem[], opts: VerifyOptions = {}): LedgerItem[] {
	return items.map((item) => verifyItem(item, opts));
}

/** Every `night`-tagged todo in the store. Never throws. */
export function readLedger(dir: string): LedgerItem[] {
	try {
		if (!existsSync(dir)) return [];
		const items: LedgerItem[] = [];
		for (const file of readdirSync(dir)) {
			if (!file.endsWith(".md")) continue;
			try {
				const item = parseLedgerItem(file.replace(/\.md$/, ""), readFileSync(join(dir, file), "utf-8"));
				if (item) items.push(item);
			} catch {
				// Unreadable todo: ignore it rather than losing the whole ledger.
			}
		}
		return items.sort((a, b) => a.id.localeCompare(b.id));
	} catch {
		return [];
	}
}

/** Items that still owe work: pending, resolved without proof, or proof that failed. */
export function unresolved(items: LedgerItem[]): LedgerItem[] {
	return items.filter(
		(item) => item.state === "pending" || item.state === "unverified" || item.state === "needs-review",
	);
}

/** Items whose evidence failed its check. */
export function needsReview(items: LedgerItem[]): LedgerItem[] {
	return items.filter((item) => item.state === "needs-review");
}

/**
 * Titles compared for duplicate detection: case, punctuation and filler words
 * differ between two nights writing down the same leftover, the work does not.
 */
export function normalizeTitle(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

export interface CarryOverResult {
	/** What the next night should start with. */
	items: LedgerItem[];
	/** Run the carry-over was taken from, when the ledger is run-scoped. */
	fromRunId?: string;
	/** Items dropped as duplicates of one already in `items`. */
	duplicates: LedgerItem[];
	/** Unresolved items from older runs, deliberately not carried. */
	stale: LedgerItem[];
}

/**
 * What the next night inherits: the unresolved items of exactly one run.
 *
 * Without a run scope `readLedger` returns every `night` todo the store ever
 * held (52 of them on 2026-08-31), so the carry-over block mixed nights and
 * listed the same leftover twice under two ids. Scope first, then dedupe by
 * normalised title, so "Obsidian daily note pass" cannot appear twice.
 *
 * `currentRunId` is excluded when given and the ledger has other runs: the
 * caller is ending that run, and its own open items are the carry-over only
 * when nothing older is in play. Items with no run tag are legacy; they are
 * reported as `stale` rather than carried, so an old store cannot flood the
 * next night.
 */
export function carryOver(items: LedgerItem[], opts: { currentRunId?: string } = {}): CarryOverResult {
	const open = unresolved(items);
	if (open.length === 0) return { items: [], duplicates: [], stale: [] };

	const runIds = [...new Set(open.map((item) => item.runId).filter((id): id is string => Boolean(id)))].sort();
	const fromRunId = opts.currentRunId && runIds.includes(opts.currentRunId) ? opts.currentRunId : runIds.at(-1);
	const scoped = fromRunId ? open.filter((item) => item.runId === fromRunId) : open;
	const stale = open.filter((item) => !scoped.includes(item));

	const seen = new Map<string, LedgerItem>();
	const duplicates: LedgerItem[] = [];
	for (const item of scoped) {
		const key = normalizeTitle(item.title) || item.id;
		if (seen.has(key)) duplicates.push(item);
		else seen.set(key, item);
	}
	return { items: [...seen.values()], ...(fromRunId ? { fromRunId } : {}), duplicates, stale };
}

/**
 * Stable digest of the ledger's meaningful state. Two settles with the same
 * fingerprint mean the nudge achieved nothing, which is a stall, not slowness.
 */
export function fingerprint(items: LedgerItem[]): string {
	return items.map((item) => `${item.id}:${item.state}:${item.evidence ?? item.reason ?? ""}`).join("|");
}

/** `- ab12 Fix the flaky login test (claimed done, no evidence)` lines for a prompt. */
export function formatUnresolved(items: LedgerItem[]): string {
	return unresolved(items)
		.map((item) => {
			const note =
				item.state === "unverified"
					? ` (marked '${item.status}' but has no Evidence:/Reason: line)`
					: item.state === "needs-review"
						? ` (marked '${item.status}' but its evidence failed: ${item.verification?.detail ?? "unknown"})`
						: "";
			return `- ${item.id} ${item.title}${note}`;
		})
		.join("\n");
}

/** Checkbox marker per ledger state. `[?]` is the one that matters: it looks resolved and is not. */
const STATE_MARKER: Record<LedgerState, string> = {
	pending: "[ ]",
	done: "[x]",
	skipped: "[-]",
	unverified: "[?]",
	"needs-review": "[!]",
};

/** One `- [x] ab12 Title - evidence: ...` line. */
function formatItem(item: LedgerItem): string {
	const marker = STATE_MARKER[item.state];
	const head = `- ${marker} ${item.id} ${item.title}`;
	if (item.state === "unverified") return `${head} - marked '${item.status}', no Evidence:/Reason:`;
	if (item.state === "needs-review") return `${head} - evidence failed: ${item.verification?.detail ?? "unknown"}`;
	if (item.state === "done" && item.evidence) return `${head} - evidence: ${item.evidence}`;
	if (item.state === "skipped" && item.reason) return `${head} - reason: ${item.reason}`;
	// A pending item's raw status carries the only extra signal there is
	// (`in-progress` vs never started), and only when it is not the default.
	if (item.state === "pending" && item.status && item.status !== "open") return `${head} - ${item.status}`;
	return head;
}

/**
 * Every item, for `/night todos`. Unresolved first: someone reading this at 2am
 * wants what is left, not twenty done items with the remaining two underneath.
 */
export function formatLedger(items: LedgerItem[]): string {
	const open = unresolved(items);
	const openIds = new Set(open.map((item) => item.id));
	const closed = items.filter((item) => !openIds.has(item.id));
	return [...open, ...closed].map(formatItem).join("\n");
}

export interface LedgerCounts {
	total: number;
	done: number;
	skipped: number;
	pending: number;
	unverified: number;
	needsReview: number;
}

export function counts(items: LedgerItem[]): LedgerCounts {
	const by = (state: LedgerState) => items.filter((item) => item.state === state).length;
	return {
		total: items.length,
		done: by("done"),
		skipped: by("skipped"),
		pending: by("pending"),
		unverified: by("unverified"),
		needsReview: by("needs-review"),
	};
}
