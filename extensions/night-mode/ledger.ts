/**
 * The night ledger: the machine-readable list of what tonight is supposed to
 * cover, so the run can be told it is not finished yet.
 *
 * It is not a new store. It is the `todos` extension's store (`PI_TODO_PATH` or
 * `<cwd>/.pi/todos`), filtered to items tagged `night`. The agent manipulates it
 * with the todo tool it already has, `/todos` shows it live, and this module
 * only reads and classifies.
 *
 * Classification is deliberately suspicious: an item claiming to be done without
 * evidence, or skipped without a reason, counts as still pending. Otherwise the
 * cheapest way for an agent to end the night is to mark everything done.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Tag that opts a todo into the night ledger. */
export const NIGHT_TAG = "night";

export type LedgerState =
	/** Not started, or in flight. */
	| "pending"
	/** Closed with evidence: really done. */
	| "done"
	/** Deliberately not done, with a reason. */
	| "skipped"
	/** Claims to be resolved but carries no evidence/reason: treated as pending. */
	| "unverified";

export interface LedgerItem {
	id: string;
	title: string;
	/** Raw todo status, kept for reporting. */
	status: string;
	state: LedgerState;
	evidence?: string;
	reason?: string;
}

/** Same resolution as `todos.ts`, so both see one store. */
export function todosDir(cwd: string): string {
	const fromEnv = process.env.PI_TODO_PATH;
	if (fromEnv?.trim()) {
		const expanded = fromEnv.startsWith("~/")
			? join(homedir(), fromEnv.slice(2))
			: fromEnv;
		return resolve(expanded);
	}
	return resolve(cwd, ".pi", "todos");
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

/** First non-empty `Label: value` line in a body, case insensitive. */
export function readField(body: string, label: string): string | undefined {
	const pattern = new RegExp(
		`^\\s*(?:[-*]\\s*)?(?:\\*\\*)?${label}(?:\\*\\*)?\\s*:\\s*(.+)$`,
		"im",
	);
	const match = pattern.exec(body);
	const value = match?.[1]?.trim();
	return value ? value : undefined;
}

const CLOSED_STATUSES = ["closed", "done", "completed"];
const SKIPPED_STATUSES = [
	"skipped",
	"blocked",
	"wontfix",
	"cancelled",
	"canceled",
];

/**
 * Where an item really stands. Closed needs `Evidence:`, skipped needs
 * `Reason:`; anything else that claims to be resolved is `unverified` and keeps
 * counting against the run.
 */
export function classify(
	status: string,
	body: string,
): { state: LedgerState; evidence?: string; reason?: string } {
	const normalized = status.trim().toLowerCase();
	const evidence = readField(body, "evidence");
	const reason = readField(body, "reason");

	if (SKIPPED_STATUSES.includes(normalized)) {
		return reason ? { state: "skipped", reason } : { state: "unverified" };
	}
	if (CLOSED_STATUSES.includes(normalized)) {
		return evidence ? { state: "done", evidence } : { state: "unverified" };
	}
	return { state: "pending" };
}

/** Parse one todo file into a ledger item, or undefined when it is not a night item. */
export function parseLedgerItem(
	id: string,
	content: string,
): LedgerItem | undefined {
	const { frontMatter, body } = splitTodo(content);
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(frontMatter || "{}") as Record<string, unknown>;
	} catch {
		return undefined;
	}
	const tags = Array.isArray(parsed.tags)
		? parsed.tags.filter((t): t is string => typeof t === "string")
		: [];
	if (!tags.some((tag) => tag.toLowerCase() === NIGHT_TAG)) return undefined;

	const status =
		typeof parsed.status === "string" && parsed.status ? parsed.status : "open";
	const { state, evidence, reason } = classify(status, body);
	return {
		id: typeof parsed.id === "string" && parsed.id ? parsed.id : id,
		title: typeof parsed.title === "string" ? parsed.title : "",
		status,
		state,
		...(evidence ? { evidence } : {}),
		...(reason ? { reason } : {}),
	};
}

/** Every `night`-tagged todo in the store. Never throws. */
export function readLedger(dir: string): LedgerItem[] {
	try {
		if (!existsSync(dir)) return [];
		const items: LedgerItem[] = [];
		for (const file of readdirSync(dir)) {
			if (!file.endsWith(".md")) continue;
			try {
				const item = parseLedgerItem(
					file.replace(/\.md$/, ""),
					readFileSync(join(dir, file), "utf-8"),
				);
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

/** Items that still owe work: genuinely pending, or resolved without proof. */
export function unresolved(items: LedgerItem[]): LedgerItem[] {
	return items.filter(
		(item) => item.state === "pending" || item.state === "unverified",
	);
}

/**
 * Stable digest of the ledger's meaningful state. Two settles with the same
 * fingerprint mean the nudge achieved nothing, which is a stall, not slowness.
 */
export function fingerprint(items: LedgerItem[]): string {
	return items
		.map(
			(item) =>
				`${item.id}:${item.state}:${item.evidence ?? item.reason ?? ""}`,
		)
		.join("|");
}

/** `- TODO-ab12 Fix HS-1234 (claimed done, no evidence)` lines for a prompt. */
export function formatUnresolved(items: LedgerItem[]): string {
	return unresolved(items)
		.map((item) => {
			const note =
				item.state === "unverified"
					? ` (marked '${item.status}' but has no Evidence:/Reason: line)`
					: "";
			return `- ${item.id} ${item.title}${note}`;
		})
		.join("\n");
}

export interface LedgerCounts {
	total: number;
	done: number;
	skipped: number;
	pending: number;
	unverified: number;
}

export function counts(items: LedgerItem[]): LedgerCounts {
	const by = (state: LedgerState) =>
		items.filter((item) => item.state === state).length;
	return {
		total: items.length,
		done: by("done"),
		skipped: by("skipped"),
		pending: by("pending"),
		unverified: by("unverified"),
	};
}
