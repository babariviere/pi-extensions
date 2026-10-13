import type { UsageSource } from "../../extensions/shared/usage-accounting.ts";

export type ReportKind = "daily" | "monthly" | "session";

/** Session store a record was read from: pi JSONL files or Pilot durable SQLite databases. */
export type UsageOrigin = "pi" | "pilot";

export interface UsageRecord {
	id: string;
	origin?: UsageOrigin;
	sessionId: string;
	project: string;
	sessionTitle?: string;
	timestamp: number;
	provider: string;
	model: string;
	usageSource?: UsageSource;
	usageKind?: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	cost?: number;
	sourcePath: string;
}

export interface ScanResult {
	records: UsageRecord[];
	/** pi JSONL session files scanned. */
	files: number;
	duplicateRecords: number;
	invalidLines: number;
	/** Pilot durable databases read successfully. */
	pilotDatabases?: number;
	/** Pilot durable databases that could not be opened or queried (for example, locked). */
	unreadableDatabases?: number;
}

export interface ModelBreakdown {
	provider: string;
	model: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	totalCost: number;
	unknownCostRecords: number;
	messages: number;
}

export interface ReportRow extends ModelBreakdown {
	key: string;
	label: string;
	firstActivity: string;
	lastActivity: string;
	models: string[];
	modelBreakdowns: ModelBreakdown[];
}

export interface UsageReport {
	kind: ReportKind;
	timezone: string;
	sessionsDir: string;
	pilotDir?: string;
	files: number;
	duplicateRecords: number;
	invalidLines: number;
	pilotDatabases?: number;
	unreadableDatabases?: number;
	rows: ReportRow[];
	totals: ModelBreakdown;
}
