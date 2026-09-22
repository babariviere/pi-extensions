import { createReadStream, type Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, relative } from "node:path";
import { createInterface } from "node:readline";
import type { ScanResult, UsageRecord } from "./types.ts";

interface SessionState {
	id: string;
	project: string;
}

const nonNegativeInteger = (value: unknown): number =>
	typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;

function reportedCost(value: unknown): number | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const cost = value as Record<string, unknown>;
	if (typeof cost.total === "number" && Number.isFinite(cost.total) && cost.total >= 0) return cost.total;
	const components = [cost.input, cost.output, cost.cacheRead, cost.cacheWrite];
	const present = components.filter(
		(component): component is number => typeof component === "number" && Number.isFinite(component) && component >= 0,
	);
	return present.length > 0 ? present.reduce((sum, component) => sum + component, 0) : undefined;
}

function recordTimestamp(entry: Record<string, unknown>, message: Record<string, unknown>): number | undefined {
	if (typeof entry.timestamp === "string") {
		const timestamp = Date.parse(entry.timestamp);
		if (Number.isFinite(timestamp)) return timestamp;
	}
	if (typeof message.timestamp === "number" && Number.isFinite(message.timestamp)) return message.timestamp;
	return undefined;
}

function dedupKey(
	entry: Record<string, unknown>,
	message: Record<string, unknown>,
	timestamp: number,
	provider: string,
	model: string,
	usage: Record<string, unknown>,
): string | undefined {
	if (typeof message.responseId === "string" && message.responseId.length > 0) return `response:${message.responseId}`;
	if (typeof entry.id !== "string" || entry.id.length === 0) return undefined;
	return [
		"message",
		entry.id,
		timestamp,
		provider,
		model,
		nonNegativeInteger(usage.input),
		nonNegativeInteger(usage.output),
		nonNegativeInteger(usage.cacheRead),
		nonNegativeInteger(usage.cacheWrite),
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
				entry = JSON.parse(line) as Record<string, unknown>;
			} catch {
				invalidLines++;
				continue;
			}
			if (entry.type === "session") {
				if (typeof entry.id === "string" && entry.id.length > 0) state.id = entry.id;
				if (typeof entry.cwd === "string" && entry.cwd.length > 0) state.project = basename(entry.cwd) || entry.cwd;
				continue;
			}
			if (entry.type !== "message" || typeof entry.message !== "object" || entry.message === null) continue;
			const message = entry.message as Record<string, unknown>;
			if (message.role !== "assistant" || typeof message.usage !== "object" || message.usage === null) continue;
			const usage = message.usage as Record<string, unknown>;
			const timestamp = recordTimestamp(entry, message);
			if (timestamp === undefined) continue;
			const provider =
				typeof message.provider === "string" && message.provider.length > 0 ? message.provider : "unknown";
			const model = typeof message.model === "string" && message.model.length > 0 ? message.model : "unknown";
			const key = dedupKey(entry, message, timestamp, provider, model, usage);
			if (key && seen.has(key)) {
				duplicateRecords++;
				continue;
			}
			if (key) seen.add(key);
			const cost = reportedCost(usage.cost);
			records.push({
				id: key ?? `${path}:${lineNumber}`,
				sessionId: state.id,
				project: state.project,
				timestamp,
				provider,
				model,
				inputTokens: nonNegativeInteger(usage.input),
				outputTokens: nonNegativeInteger(usage.output),
				cacheReadTokens: nonNegativeInteger(usage.cacheRead),
				cacheWriteTokens: nonNegativeInteger(usage.cacheWrite),
				...(cost === undefined ? {} : { cost }),
				sourcePath: path,
			});
		}
	}

	return { records, files: files.length, duplicateRecords, invalidLines };
}
