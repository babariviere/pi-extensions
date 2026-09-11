import { createHash } from "node:crypto";
import type { BackgroundAgentsDatabase, SourceEventResult } from "../database.ts";
import type { BackgroundSource, RolloutMode, SourceEvent } from "../../types.ts";

/** The small persistence boundary shared by every outbound source. */
export interface SourceStore {
	recordSourceEvent(
		event: SourceEvent,
		options?: { rolloutMode?: RolloutMode; priority?: number; caseId?: string },
	): SourceEventResult;
	recordSourceEventAndAdvanceCursor?(
		event: SourceEvent,
		cursor: { cursor?: string; revision?: string },
		options?: { rolloutMode?: RolloutMode; priority?: number; caseId?: string },
	): SourceEventResult;
	setSourceCursor?(source: BackgroundSource, cursor?: string, revision?: string): void;
	getSourceCursor?(source: BackgroundSource): { cursor?: string; revision?: string } | undefined;
}

export type SourceDatabase = SourceStore | BackgroundAgentsDatabase;

export interface SourceAdapterOptions {
	store: SourceStore;
	rolloutMode?: RolloutMode;
	priority?: number;
	now?: () => Date;
}

export interface SourceAdapter {
	readonly source: BackgroundSource;
	start?(): Promise<void>;
	stop?(): Promise<void>;
	poll?(): Promise<unknown>;
}

export interface NormalizableSourceEvent {
	source: BackgroundSource;
	sourceKey: string;
	revision?: string;
	receivedAt?: string | Date;
	title: string;
	body: string;
	fingerprint?: string;
	repository?: string;
	service?: string;
	metadata?: Record<string, unknown>;
}

export function stableJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	return `{${Object.entries(value as Record<string, unknown>)
		.filter(([, child]) => child !== undefined)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
		.join(",")}}`;
}

export function fingerprint(value: unknown): string {
	return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function normalizeSourceEvent(input: NormalizableSourceEvent, now = new Date()): SourceEvent {
	if (!input.sourceKey.trim()) throw new Error("sourceKey must be a non-empty string");
	if (!input.title.trim()) throw new Error("title must be a non-empty string");
	if (typeof input.body !== "string") throw new Error("body must be a string");
	const receivedAt =
		input.receivedAt instanceof Date ? input.receivedAt.toISOString() : (input.receivedAt ?? now.toISOString());
	return {
		source: input.source,
		sourceKey: input.sourceKey.trim(),
		revision: input.revision?.trim() ?? "",
		receivedAt,
		title: input.title.trim(),
		body: input.body,
		fingerprint: input.fingerprint,
		repository: input.repository?.trim() || undefined,
		service: input.service?.trim() || undefined,
		metadata: input.metadata ?? {},
	};
}

/** Persist first, then advance a poll cursor. The database implementation does this atomically. */
export function persistSourceEvent(
	options: SourceAdapterOptions,
	event: NormalizableSourceEvent,
	cursor?: { cursor?: string; revision?: string },
): SourceEventResult {
	const normalized = normalizeSourceEvent(event, options.now?.() ?? new Date());
	const caseOptions = { rolloutMode: options.rolloutMode, priority: options.priority };
	if (cursor && options.store.recordSourceEventAndAdvanceCursor) {
		return options.store.recordSourceEventAndAdvanceCursor(normalized, cursor, caseOptions);
	}
	const result = options.store.recordSourceEvent(normalized, caseOptions);
	if (cursor && options.store.setSourceCursor)
		options.store.setSourceCursor(normalized.source, cursor.cursor, cursor.revision);
	return result;
}
