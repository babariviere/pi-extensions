import type { BackgroundAgentsDatabase } from "../database.ts";
import type {
	BackgroundSource,
	ClassifierExample,
	ClassificationDisposition,
	InputKind,
	MemoryEntry,
	RelatedCase,
	SourceEvent,
} from "../../types.ts";

export interface MemoryStore {
	createMemoryEntry(input: {
		id?: string;
		caseId?: string;
		finding: string;
		outcome?: string;
		rootCause?: string;
		evidenceSummary: string;
		confidence: number;
		scope: string;
		supersedesId?: string;
	}): string;
	approveMemoryEntry(memoryId: string, actor: string, status?: "approved" | "rejected"): void;
}

export interface RelatedCaseQuery {
	caseId?: string;
	sourceKeys?: string[];
	fingerprints?: string[];
	text?: string;
	limit?: number;
}

export interface RelatedCaseSummary extends RelatedCase {
	title: string;
	source: BackgroundSource;
	memoryIds?: string[];
}

interface Row {
	[key: string]: unknown;
}

function stringValue(row: Row, key: string): string {
	return String(row[key]);
}

function jsonValue(value: unknown, field: string): Record<string, unknown> {
	if (typeof value !== "string") throw new Error(`${field} is not valid JSON`);
	try {
		const parsed: unknown = JSON.parse(value);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
		return parsed as Record<string, unknown>;
	} catch (error) {
		throw new Error(`${field} is not valid JSON`, { cause: error });
	}
}

function boundedLimit(limit: number | undefined): number {
	if (limit === undefined) return 8;
	if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
	return Math.min(limit, 50);
}

function ftsQuery(text: string | undefined): string | undefined {
	if (!text) return undefined;
	const terms = text
		.normalize("NFKC")
		.match(/[\p{L}\p{N}_]+/gu)
		?.filter((term) => term.length > 1)
		.slice(0, 12);
	if (!terms?.length) return undefined;
	return terms.map((term) => `"${term.replaceAll('"', '""')}"*`).join(" OR ");
}

function supersededBy(database: BackgroundAgentsDatabase, memoryIds: string[]): string[] {
	if (!memoryIds.length) return [];
	const placeholders = memoryIds.map(() => "?").join(", ");
	return database
		.all<{ id: string }>(
			`SELECT id FROM memory_entries WHERE approval_status = 'approved' AND supersedes_id IN (${placeholders}) ORDER BY created_at DESC`,
			...memoryIds,
		)
		.map((row) => row.id);
}

function caseDetails(
	database: BackgroundAgentsDatabase,
	caseId: string,
): { title: string; source: BackgroundSource } | undefined {
	const row = database.get<Row>("SELECT title, source FROM cases WHERE id = ?", caseId);
	if (!row) return undefined;
	return { title: stringValue(row, "title"), source: stringValue(row, "source") as BackgroundSource };
}

/** Retrieve exact identifiers first, then only bounded approved FTS summaries. */
export function retrieveRelatedCases(
	database: BackgroundAgentsDatabase,
	query: RelatedCaseQuery,
): RelatedCaseSummary[] {
	const limit = boundedLimit(query.limit);
	const excluded = query.caseId;
	const results: RelatedCaseSummary[] = [];
	const seen = new Set<string>();
	const add = (caseId: string, score: number, rationale: string, provenance: string, memoryIds: string[] = []) => {
		if (caseId === excluded || seen.has(caseId)) return;
		const details = caseDetails(database, caseId);
		if (!details) return;
		const associatedMemoryIds = memoryIds.length
			? memoryIds
			: database
					.all<{ id: string }>(
						"SELECT id FROM memory_entries WHERE case_id = ? AND approval_status = 'approved' ORDER BY updated_at DESC",
						caseId,
					)
					.map((row) => row.id);
		seen.add(caseId);
		results.push({
			caseId,
			type: score >= 95 ? "duplicate" : score >= 80 ? "recurrence" : "related",
			score,
			rationale,
			provenance,
			title: details.title,
			source: details.source,
			memoryIds: associatedMemoryIds.length ? associatedMemoryIds : undefined,
			supersededBy: supersededBy(database, associatedMemoryIds),
		});
	};

	const exactKeys = [...new Set((query.sourceKeys ?? []).map((value) => value.trim()).filter(Boolean))];
	if (exactKeys.length) {
		const placeholders = exactKeys.map(() => "?").join(", ");
		for (const row of database.all<Row>(
			`SELECT case_id, source_key FROM source_events WHERE source_key IN (${placeholders}) ORDER BY created_at DESC`,
			...exactKeys,
		)) {
			add(
				stringValue(row, "case_id"),
				100,
				"Exact source identifier match",
				`source-key:${stringValue(row, "source_key")}`,
			);
			if (results.length >= limit) return results;
		}
	}

	const exactFingerprints = [...new Set((query.fingerprints ?? []).map((value) => value.trim()).filter(Boolean))];
	if (exactFingerprints.length) {
		const placeholders = exactFingerprints.map(() => "?").join(", ");
		for (const row of database.all<Row>(
			`SELECT case_id, fingerprint FROM source_events WHERE fingerprint IN (${placeholders}) AND fingerprint IS NOT NULL ORDER BY created_at DESC`,
			...exactFingerprints,
		)) {
			add(
				stringValue(row, "case_id"),
				95,
				"Exact fingerprint match",
				`fingerprint:${stringValue(row, "fingerprint")}`,
			);
			if (results.length >= limit) return results;
		}
	}

	const match = ftsQuery(query.text);
	if (!match) return results;
	for (const row of database.all<Row>(
		"SELECT case_id FROM case_summaries_fts WHERE case_summaries_fts MATCH ? LIMIT ?",
		match,
		limit,
	)) {
		add(stringValue(row, "case_id"), 60, "Bounded full-text case-summary match", "fts:case-summary");
		if (results.length >= limit) return results;
	}
	for (const row of database.all<Row>(
		"SELECT memory_id FROM approved_memory_fts WHERE approved_memory_fts MATCH ? LIMIT ?",
		match,
		limit,
	)) {
		const memory = database.get<Row>(
			"SELECT case_id FROM memory_entries WHERE id = ? AND approval_status = 'approved'",
			row.memory_id,
		);
		if (!memory?.case_id) continue;
		const memoryId = stringValue(row, "memory_id");
		add(
			stringValue(memory, "case_id"),
			55,
			"Bounded full-text approved-memory match",
			`fts:approved-memory:${memoryId}`,
			[memoryId],
		);
		if (results.length >= limit) return results;
	}
	return results;
}

export function approvedClassifierExamples(database: BackgroundAgentsDatabase, limit = 12): ClassifierExample[] {
	const bounded = boundedLimit(limit);
	return database
		.all<Row>(
			"SELECT f.id, f.correction, c.source, cl.input_kind, cl.disposition FROM feedback f LEFT JOIN cases c ON c.id = f.case_id LEFT JOIN classifications cl ON cl.id = f.classification_id ORDER BY f.created_at DESC LIMIT ?",
			bounded,
		)
		.map((row) => {
			const correction = jsonValue(row.correction, "feedback correction");
			return {
				id: stringValue(row, "id"),
				source: row.source == null ? undefined : (stringValue(row, "source") as BackgroundSource),
				inputKind: row.input_kind == null ? undefined : (stringValue(row, "input_kind") as InputKind),
				disposition:
					row.disposition == null ? undefined : (stringValue(row, "disposition") as ClassificationDisposition),
				correction,
				provenance: `operator-feedback:${stringValue(row, "id")}`,
			};
		});
}

export function approvedMemoryEntries(database: BackgroundAgentsDatabase, limit = 20): MemoryEntry[] {
	return database
		.all<Row>(
			"SELECT id, case_id, finding, outcome, root_cause, evidence_summary, confidence, scope, approval_status, supersedes_id, created_at, updated_at FROM memory_entries WHERE approval_status = 'approved' ORDER BY updated_at DESC LIMIT ?",
			boundedLimit(limit),
		)
		.map((row) => ({
			id: stringValue(row, "id"),
			caseId: row.case_id == null ? undefined : stringValue(row, "case_id"),
			finding: stringValue(row, "finding"),
			outcome: row.outcome == null ? undefined : stringValue(row, "outcome"),
			rootCause: row.root_cause == null ? undefined : stringValue(row, "root_cause"),
			evidenceSummary: stringValue(row, "evidence_summary"),
			confidence: Number(row.confidence),
			scope: stringValue(row, "scope"),
			approvalStatus: "approved",
			supersedesId: row.supersedes_id == null ? undefined : stringValue(row, "supersedes_id"),
			createdAt: stringValue(row, "created_at"),
			updatedAt: stringValue(row, "updated_at"),
		}));
}

export function sourceMemoryQuery(event: SourceEvent): RelatedCaseQuery {
	return {
		sourceKeys: [event.sourceKey],
		fingerprints: event.fingerprint ? [event.fingerprint] : [],
		text: event.title,
	};
}

export function createMemoryEntry(
	database: BackgroundAgentsDatabase,
	input: Parameters<BackgroundAgentsDatabase["createMemoryEntry"]>[0],
): string {
	return database.createMemoryEntry(input);
}

export function approveMemoryEntry(
	database: BackgroundAgentsDatabase,
	memoryId: string,
	actor: string,
	status?: "approved" | "rejected",
): void {
	database.approveMemoryEntry(memoryId, actor, status);
}
