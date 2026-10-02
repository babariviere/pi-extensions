import { createReadStream, type Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, relative } from "node:path";
import { createInterface } from "node:readline";
import { extractAccountedUsage } from "../../extensions/shared/usage-accounting.ts";
import type { ScanResult, UsageRecord } from "./types.ts";

interface SessionState {
	id: string;
	project: string;
}

function recordTimestamp(entry: Record<string, unknown>, message?: Record<string, unknown>): number | undefined {
	if (typeof entry.timestamp === "string") {
		const timestamp = Date.parse(entry.timestamp);
		if (Number.isFinite(timestamp)) return timestamp;
	}
	if (typeof message?.timestamp === "number" && Number.isFinite(message.timestamp)) return message.timestamp;
	return undefined;
}

function dedupKey(
	entry: Record<string, unknown>,
	message: Record<string, unknown>,
	timestamp: number,
	usage: NonNullable<ReturnType<typeof extractAccountedUsage>>,
): string | undefined {
	if (usage.source === "assistant" && typeof message.responseId === "string" && message.responseId.length > 0) {
		return `response:${message.responseId}`;
	}
	if (typeof entry.id !== "string" || entry.id.length === 0) return undefined;
	// Clones preserve the entry and usage. IDs alone are short and can collide
	// across independent sessions, so include the billable record's identity.
	if (usage.source !== "assistant")
		return `entry:${JSON.stringify([
			entry.type,
			entry.id,
			timestamp,
			usage.source,
			usage.kind,
			usage.provider,
			usage.model,
			usage.input,
			usage.output,
			usage.cacheRead,
			usage.cacheWrite,
			usage.cost,
		])}`;
	return [
		"message",
		entry.id,
		timestamp,
		usage.provider,
		usage.model,
		usage.input,
		usage.output,
		usage.cacheRead,
		usage.cacheWrite,
	].join(":");
}

async function sessionFiles(root: string): Promise<string[]> {
	const files: string[] = [];
	const visit = async (directory: string): Promise<void> => {
		let entries: Dirent[];
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		entries.sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of entries) {
			const path = `${directory}/${entry.name}`;
			if (entry.isDirectory()) await visit(path);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
		}
	};
	await visit(root.replace(/\/$/, ""));
	return files;
}

function fallbackProject(root: string, path: string): string {
	const first = relative(root, path).split(/[\\/]/)[0];
	return first && first !== basename(path) ? first : "unknown";
}

export async function scanSessions(root: string): Promise<ScanResult> {
	const files = await sessionFiles(root);
	const records: UsageRecord[] = [];
	const seen = new Set<string>();
	let duplicateRecords = 0;
	let invalidLines = 0;

	for (const path of files) {
		const state: SessionState = { id: basename(path, ".jsonl"), project: fallbackProject(root, path) };
		let lineNumber = 0;
		const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
		for await (const line of lines) {
			lineNumber++;
			if (line.trim().length === 0) continue;
			let entry: Record<string, unknown>;
			try {
				const parsed: unknown = JSON.parse(line);
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
					invalidLines++;
					continue;
				}
				entry = parsed as Record<string, unknown>;
			} catch {
				invalidLines++;
				continue;
			}
			if (entry.type === "session") {
				if (typeof entry.id === "string" && entry.id.length > 0) state.id = entry.id;
				if (typeof entry.cwd === "string" && entry.cwd.length > 0) state.project = basename(entry.cwd) || entry.cwd;
				continue;
			}
			const message =
				typeof entry.message === "object" && entry.message !== null
					? (entry.message as Record<string, unknown>)
					: {};
			const usage = extractAccountedUsage(entry);
			if (!usage) continue;
			const timestamp = recordTimestamp(entry, message);
			if (timestamp === undefined) continue;
			const key = dedupKey(entry, message, timestamp, usage);
			if (key && seen.has(key)) {
				duplicateRecords++;
				continue;
			}
			if (key) seen.add(key);
			records.push({
				id: key ?? `${path}:${lineNumber}`,
				// Child-session records retain their own ID rather than being folded into the parent session.
				sessionId: state.id,
				project: state.project,
				timestamp,
				provider: usage.provider,
				model: usage.model,
				usageSource: usage.source,
				...(usage.kind === undefined ? {} : { usageKind: usage.kind }),
				inputTokens: usage.input,
				outputTokens: usage.output,
				cacheReadTokens: usage.cacheRead,
				cacheWriteTokens: usage.cacheWrite,
				...(usage.cost === undefined ? {} : { cost: usage.cost }),
				sourcePath: path,
			});
		}
	}

	return { records, files: files.length, duplicateRecords, invalidLines };
}
