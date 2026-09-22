import type { ModelBreakdown, ReportKind, ReportRow, ScanResult, UsageRecord, UsageReport } from "./types.ts";

interface MutableBreakdown extends ModelBreakdown {
	modelsSet?: Set<string>;
	breakdowns?: Map<string, MutableBreakdown>;
	firstTimestamp?: number;
	lastTimestamp?: number;
}

const emptyBreakdown = (provider = "", model = ""): MutableBreakdown => ({
	provider,
	model,
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	totalTokens: 0,
	totalCost: 0,
	unknownCostRecords: 0,
	messages: 0,
});

function add(target: MutableBreakdown, record: UsageRecord): void {
	target.inputTokens += record.inputTokens;
	target.outputTokens += record.outputTokens;
	target.cacheReadTokens += record.cacheReadTokens;
	target.cacheWriteTokens += record.cacheWriteTokens;
	target.totalTokens += record.inputTokens + record.outputTokens + record.cacheReadTokens + record.cacheWriteTokens;
	target.messages++;
	if (record.cost === undefined) target.unknownCostRecords++;
	else target.totalCost += record.cost;
}

export function dateKey(timestamp: number, timezone: string): string {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(timestamp);
	const value = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? "";
	return `${value("year")}-${value("month")}-${value("day")}`;
}

function rowIdentity(kind: ReportKind, record: UsageRecord, timezone: string): { key: string; label: string } {
	if (kind === "session")
		return { key: record.sessionId, label: `${record.project} (${record.sessionId.slice(0, 8)})` };
	const day = dateKey(record.timestamp, timezone);
	return kind === "monthly" ? { key: day.slice(0, 7), label: day.slice(0, 7) } : { key: day, label: day };
}

function publicBreakdown(value: MutableBreakdown): ModelBreakdown {
	return {
		provider: value.provider,
		model: value.model,
		inputTokens: value.inputTokens,
		outputTokens: value.outputTokens,
		cacheReadTokens: value.cacheReadTokens,
		cacheWriteTokens: value.cacheWriteTokens,
		totalTokens: value.totalTokens,
		totalCost: value.totalCost,
		unknownCostRecords: value.unknownCostRecords,
		messages: value.messages,
	};
}

export interface BuildReportOptions {
	kind: ReportKind;
	timezone: string;
	sessionsDir: string;
	since?: string;
	until?: string;
}

export function buildReport(scan: ScanResult, options: BuildReportOptions): UsageReport {
	const rows = new Map<string, MutableBreakdown & { label: string }>();
	const totals = emptyBreakdown();
	for (const record of scan.records) {
		const day = dateKey(record.timestamp, options.timezone);
		if (options.since && day < options.since) continue;
		if (options.until && day > options.until) continue;
		const identity = rowIdentity(options.kind, record, options.timezone);
		let row = rows.get(identity.key);
		if (!row) {
			row = {
				...emptyBreakdown(),
				label: identity.label,
				modelsSet: new Set(),
				breakdowns: new Map(),
				firstTimestamp: record.timestamp,
				lastTimestamp: record.timestamp,
			};
			rows.set(identity.key, row);
		}
		add(row, record);
		add(totals, record);
		row.modelsSet!.add(`${record.provider}/${record.model}`);
		row.firstTimestamp = Math.min(row.firstTimestamp!, record.timestamp);
		row.lastTimestamp = Math.max(row.lastTimestamp!, record.timestamp);
		const modelKey = `${record.provider}\u0000${record.model}`;
		let breakdown = row.breakdowns!.get(modelKey);
		if (!breakdown) {
			breakdown = emptyBreakdown(record.provider, record.model);
			row.breakdowns!.set(modelKey, breakdown);
		}
		add(breakdown, record);
	}
	const outputRows: ReportRow[] = [...rows.entries()]
		.map(([key, row]) => ({
			...publicBreakdown(row),
			key,
			label: row.label,
			firstActivity: new Date(row.firstTimestamp!).toISOString(),
			lastActivity: new Date(row.lastTimestamp!).toISOString(),
			models: [...row.modelsSet!].sort(),
			modelBreakdowns: [...row.breakdowns!.values()]
				.map(publicBreakdown)
				.sort((left, right) => right.totalCost - left.totalCost || left.model.localeCompare(right.model)),
		}))
		.sort((left, right) => left.key.localeCompare(right.key));
	return {
		kind: options.kind,
		timezone: options.timezone,
		sessionsDir: options.sessionsDir,
		files: scan.files,
		duplicateRecords: scan.duplicateRecords,
		invalidLines: scan.invalidLines,
		rows: outputRows,
		totals: publicBreakdown(totals),
	};
}
