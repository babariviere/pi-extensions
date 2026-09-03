/**
 * What tonight has proven about its own capabilities, as a journal.
 *
 * `preflight.ts` answers this once, at 20:52, for six fixed questions. Anything
 * the run discovers *later* had nowhere to go: on 2026-09-02 the finding that
 * the subagent runner could not start a working child was learned at 21:20 and
 * lived only as prose inside one todo body and the morning report, so the next
 * run started from the same six probes and would have rediscovered it the same
 * way, one burnt hour at a time.
 *
 * So capability findings are appended here, by whoever learns them, as one JSON
 * object per line. Append-only and best-effort: a journal that throws, or that
 * has to be rewritten to be updated, is a second failure mode at 3am. Readers
 * take the last entry per capability (`latestCapabilities`).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentWorkspacesRoot } from "./agent-workspace.ts";

/** How well a capability works. `broken` means not worth another attempt. */
export type CapabilityState = "working" | "degraded" | "broken";

export interface CapabilityEntry {
	/** Epoch ms the finding was made. */
	at: number;
	/** Stable id, e.g. `subagent-launch`, `loopback-tcp`, `push`. */
	capability: string;
	state: CapabilityState;
	/** The evidence, in one line: the error, the exit code, the command. */
	detail?: string;
}

/**
 * Beside the preflight report, for the same reasons: inside the run's writable
 * set and readable by every child.
 */
export function capabilityJournalPathFor(input: { workspacePath?: string; reportPath: string }): string {
	const dir = input.workspacePath ? agentWorkspacesRoot(input.workspacePath) : dirname(input.reportPath);
	return join(dir, "capability-journal.jsonl");
}

/** Append one finding. Never throws; returns false when it could not be written. */
export function appendCapability(path: string, entry: CapabilityEntry): boolean {
	try {
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf-8");
		return true;
	} catch {
		return false;
	}
}

/** Every finding, oldest first. A malformed line is skipped, not fatal. */
export function readCapabilityJournal(path: string): CapabilityEntry[] {
	if (!existsSync(path)) return [];
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch {
		return [];
	}
	const entries: CapabilityEntry[] = [];
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) continue;
		try {
			const parsed = JSON.parse(trimmed) as CapabilityEntry;
			if (typeof parsed.capability === "string" && typeof parsed.state === "string") entries.push(parsed);
		} catch {
			// A half-written line (two writers, one crash) is not worth failing over.
		}
	}
	return entries;
}

/** The current verdict per capability: the last thing said about each. */
export function latestCapabilities(entries: CapabilityEntry[]): CapabilityEntry[] {
	const latest = new Map<string, CapabilityEntry>();
	for (const entry of entries) latest.set(entry.capability, entry);
	return [...latest.values()].sort((a, b) => a.capability.localeCompare(b.capability));
}

/**
 * The journal as prose for a prompt or a report: one line per capability, the
 * verdict first, because the reader has one question ("can I do X tonight?").
 */
export function formatCapabilities(entries: CapabilityEntry[]): string {
	const latest = latestCapabilities(entries);
	if (latest.length === 0) return "Nothing recorded yet.";
	return latest
		.map((entry) => {
			const when = new Date(entry.at).toISOString();
			return `- ${entry.capability}: ${entry.state}${entry.detail ? ` - ${entry.detail}` : ""} (${when})`;
		})
		.join("\n");
}
