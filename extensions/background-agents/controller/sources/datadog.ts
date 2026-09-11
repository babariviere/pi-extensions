import type { SourceEventResult } from "../database.ts";
import { type SourceAdapter, type SourceAdapterOptions, fingerprint, persistSourceEvent } from "./source.ts";

export interface DatadogQuery {
	id: string;
	query: string;
	repository?: string;
	service?: string;
}

export interface DatadogRecord {
	id?: string | number;
	timestamp?: string | number;
	time?: string | number;
	date?: string | number;
	status?: string;
	title?: string;
	name?: string;
	message?: string;
	service?: string;
	[key: string]: unknown;
}

export interface DatadogClient {
	queryMonitors(query: string, from: string, to: string): Promise<DatadogRecord[] | { results?: DatadogRecord[] }>;
	queryErrors(query: string, from: string, to: string): Promise<DatadogRecord[] | { results?: DatadogRecord[] }>;
}

export interface DatadogSourceOptions extends SourceAdapterOptions {
	client: DatadogClient;
	monitorQueries?: DatadogQuery[];
	errorQueries?: DatadogQuery[];
	overlapMs?: number;
	repositoryMappings?: Record<string, string>;
}

interface Watermark {
	watermark: string;
}

function unwrap(value: DatadogRecord[] | { results?: DatadogRecord[] }): DatadogRecord[] {
	return Array.isArray(value) ? value : (value.results ?? []);
}

function recordTime(record: DatadogRecord, fallback: Date): Date {
	const value = record.timestamp ?? record.time ?? record.date;
	if (typeof value === "number") {
		const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
		const date = new Date(milliseconds);
		if (!Number.isNaN(date.getTime())) return date;
	}
	if (typeof value === "string") {
		const date = new Date(value);
		if (!Number.isNaN(date.getTime())) return date;
	}
	return fallback;
}

function readWatermark(options: DatadogSourceOptions): Date {
	const raw = options.store.getSourceCursor?.("datadog")?.cursor;
	if (!raw) return new Date(0);
	try {
		const parsed = JSON.parse(raw) as Partial<Watermark>;
		const date = new Date(parsed.watermark ?? "");
		return Number.isNaN(date.getTime()) ? new Date(0) : date;
	} catch {
		const date = new Date(raw);
		return Number.isNaN(date.getTime()) ? new Date(0) : date;
	}
}

function recordId(record: DatadogRecord): string | undefined {
	const id = record.id;
	return id === undefined || id === null ? undefined : String(id);
}

function eventFor(
	kind: "monitor" | "error",
	query: DatadogQuery,
	record: DatadogRecord,
	receivedAt: Date,
	repositoryMappings?: Record<string, string>,
): Parameters<typeof persistSourceEvent>[1] {
	const eventFingerprint = fingerprint({ kind, query: query.id, record });
	const id = recordId(record);
	const sourceKey = `datadog:${kind}:${query.id}:${id ?? eventFingerprint}`;
	const title = record.title ?? record.name ?? record.message ?? `${kind} result for ${query.id}`;
	const body = record.message ?? JSON.stringify(record);
	return {
		source: "datadog",
		sourceKey,
		revision: eventFingerprint,
		receivedAt,
		title,
		body,
		fingerprint: eventFingerprint,
		repository: query.repository ? (repositoryMappings?.[query.repository] ?? query.repository) : undefined,
		service: record.service ?? query.service,
		metadata: { queryId: query.id, query: query.query, kind, payload: record },
	};
}

export class DatadogSourceAdapter implements SourceAdapter {
	readonly source = "datadog" as const;
	private readonly options: DatadogSourceOptions;

	constructor(options: DatadogSourceOptions) {
		this.options = options;
	}

	async poll(): Promise<SourceEventResult[]> {
		const now = this.options.now?.() ?? new Date();
		const previous = readWatermark(this.options);
		const overlapMs = this.options.overlapMs ?? 5 * 60_000;
		if (!Number.isSafeInteger(overlapMs) || overlapMs < 0)
			throw new Error("overlapMs must be a non-negative integer");
		const from = new Date(Math.max(0, previous.getTime() - overlapMs));
		const to = now;
		const results: SourceEventResult[] = [];
		let watermark = Math.max(previous.getTime(), to.getTime());

		for (const query of this.options.monitorQueries ?? []) {
			const records = unwrap(
				await this.options.client.queryMonitors(query.query, from.toISOString(), to.toISOString()),
			);
			for (const record of records) {
				const receivedAt = recordTime(record, now);
				watermark = Math.max(watermark, receivedAt.getTime());
				results.push(
					persistSourceEvent(
						this.options,
						eventFor("monitor", query, record, receivedAt, this.options.repositoryMappings),
					),
				);
			}
		}
		for (const query of this.options.errorQueries ?? []) {
			const records = unwrap(
				await this.options.client.queryErrors(query.query, from.toISOString(), to.toISOString()),
			);
			for (const record of records) {
				const receivedAt = recordTime(record, now);
				watermark = Math.max(watermark, receivedAt.getTime());
				results.push(
					persistSourceEvent(
						this.options,
						eventFor("error", query, record, receivedAt, this.options.repositoryMappings),
					),
				);
			}
		}
		if (this.options.store.setSourceCursor) {
			this.options.store.setSourceCursor(
				"datadog",
				JSON.stringify({ watermark: new Date(watermark).toISOString() }),
			);
		}
		return results;
	}
}
