import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { UsageCollector } from "./scanner.ts";
import type { ScanResult } from "./types.ts";

/** Durable stores that hold conversation entries: the session harness and subagent run databases. */
const DATABASE_NAMES = new Set(["harness.sqlite", "runs.sqlite"]);

interface SessionMeta {
	id: string;
	title?: string;
	project: string;
}

type RecordLike = Record<string, unknown>;

const isRecord = (value: unknown): value is RecordLike =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined =>
	typeof value === "string" && value.length > 0 ? value : undefined;

async function readJson(path: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch {
		return undefined;
	}
}

async function projectNames(home: string): Promise<Map<string, string>> {
	const names = new Map<string, string>();
	const projects = await readJson(join(home, "projects.json"));
	if (!Array.isArray(projects)) return names;
	for (const project of projects) {
		if (!isRecord(project)) continue;
		const id = text(project.id);
		const name = text(project.name) ?? (text(project.path) && basename(project.path as string));
		if (id && name) names.set(id, name);
	}
	return names;
}

function sessionMeta(id: string, value: unknown, projects: Map<string, string>): SessionMeta {
	const meta = isRecord(value) ? value : {};
	const workspace = isRecord(meta.workspace) ? meta.workspace : {};
	const projectId = text(meta.projectId);
	const source = text(workspace.source);
	const cwd = text(meta.cwd);
	// Pilot sessions run in per-session workspace copies, so prefer the registered project or its source checkout.
	const project =
		(projectId && projects.get(projectId)) ||
		(source && basename(source)) ||
		(cwd && !cwd.includes(`${sep}sessions${sep}`) && basename(cwd)) ||
		"unknown";
	const title = text(meta.title);
	return { id: text(meta.id) ?? id, project, ...(title ? { title } : {}) };
}

async function databases(directory: string): Promise<string[]> {
	const found: string[] = [];
	const visit = async (path: string): Promise<void> => {
		let entries;
		try {
			entries = await readdir(path, { withFileTypes: true });
		} catch {
			return;
		}
		entries.sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of entries) {
			const child = join(path, entry.name);
			if (entry.isDirectory()) await visit(child);
			else if (entry.isFile() && DATABASE_NAMES.has(entry.name)) found.push(child);
		}
	};
	await visit(directory);
	return found;
}

/**
 * Attribute a database inside a session's durable directory. The session harness belongs to
 * the session itself; subagent runs (`subagent-runs/<parent>/<run>/<name>.durable/runs.sqlite`)
 * are reported as their own child sessions, matching how pi child session files are handled.
 */
export function databaseSession(durableDir: string, path: string, meta: SessionMeta): { id: string; title?: string } {
	const segments = relative(durableDir, path).split(/[\\/]/);
	if (segments.length === 1) return { id: meta.id, ...(meta.title ? { title: meta.title } : {}) };
	const runs = segments.lastIndexOf("subagent-runs");
	const run = runs >= 0 ? segments[runs + 2] : undefined;
	if (run && runs + 3 < segments.length) {
		const name = segments[runs + 3]!;
		const title = name.endsWith(".durable") ? name.slice(0, -".durable".length) : meta.title;
		return { id: run, ...(title ? { title } : {}) };
	}
	return { id: `${meta.id}:${segments.slice(0, -1).join("/")}`, ...(meta.title ? { title: meta.title } : {}) };
}

/** Read assistant and tool-result messages from a durable database's entry records. */
function readEntries(path: string): Array<{ id: number; record: string }> {
	const db = new DatabaseSync(path, { readOnly: true, timeout: 2000 });
	try {
		const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'entries'").get();
		if (!table) return [];
		// Only entries that can carry billable usage; the JSON payload is parsed in JS.
		return db
			.prepare("SELECT id, record FROM entries WHERE instr(record, '\"usage\"') > 0 ORDER BY id")
			.all() as Array<{ id: number; record: string }>;
	} finally {
		db.close();
	}
}

/**
 * Scan Pilot's durable session databases (`<home>/sessions/<id>/durable`). Pilot stores each
 * conversation entry as `{ kind, model: Message[] }`, so each model message is accounted like a
 * pi `message` entry with recorded costs.
 */
export async function scanPilot(home: string, collector = new UsageCollector()): Promise<ScanResult> {
	const duplicatesBefore = collector.duplicateRecords;
	const recordsBefore = collector.records.length;
	const projects = await projectNames(home);
	const sessionsRoot = join(home, "sessions");
	let sessions: string[] = [];
	try {
		sessions = (await readdir(sessionsRoot, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	let pilotDatabases = 0;
	let unreadableDatabases = 0;
	let invalidLines = 0;
	for (const session of sessions) {
		const directory = join(sessionsRoot, session);
		const meta = sessionMeta(session, await readJson(join(directory, "meta.json")), projects);
		const durableDir = join(directory, "durable");
		for (const path of await databases(durableDir)) {
			let rows: Array<{ id: number; record: string }>;
			try {
				rows = readEntries(path);
			} catch {
				unreadableDatabases++;
				continue;
			}
			pilotDatabases++;
			const owner = databaseSession(durableDir, path, meta);
			for (const row of rows) {
				let record: unknown;
				try {
					record = JSON.parse(row.record);
				} catch {
					invalidLines++;
					continue;
				}
				if (!isRecord(record) || !Array.isArray(record.model)) continue;
				for (const [index, message] of record.model.entries()) {
					if (!isRecord(message)) continue;
					collector.add(
						{ type: "message", id: `pilot:${row.id}:${index}`, message },
						{
							origin: "pilot",
							sessionId: owner.id,
							project: meta.project,
							...(owner.title ? { sessionTitle: owner.title } : {}),
							sourcePath: path,
							fallbackId: `${path}:${row.id}:${index}`,
						},
					);
				}
			}
		}
	}
	return {
		records: collector.records.slice(recordsBefore),
		files: 0,
		duplicateRecords: collector.duplicateRecords - duplicatesBefore,
		invalidLines,
		pilotDatabases,
		unreadableDatabases,
	};
}
