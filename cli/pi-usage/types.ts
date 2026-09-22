export type ReportKind = "daily" | "monthly" | "session";

export interface UsageRecord {
	id: string;
	sessionId: string;
	project: string;
	timestamp: number;
	provider: string;
	model: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	cost?: number;
	sourcePath: string;
}

export interface ScanResult {
	records: UsageRecord[];
	files: number;
	duplicateRecords: number;
	invalidLines: number;
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
	files: number;
	duplicateRecords: number;
	invalidLines: number;
	rows: ReportRow[];
	totals: ModelBreakdown;
}
