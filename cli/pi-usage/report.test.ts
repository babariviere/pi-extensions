import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReport, dateKey } from "./report.ts";
import type { ScanResult, UsageRecord } from "./types.ts";

const record = (overrides: Partial<UsageRecord> = {}): UsageRecord => ({
	id: "one",
	sessionId: "session-1",
	project: "project",
	timestamp: Date.parse("2026-09-21T22:30:00Z"),
	provider: "provider",
	model: "model",
	inputTokens: 10,
	outputTokens: 5,
	cacheReadTokens: 20,
	cacheWriteTokens: 2,
	cost: 1.25,
	sourcePath: "/sessions/project/one.jsonl",
	...overrides,
});

const scan = (records: UsageRecord[]): ScanResult => ({ records, files: 2, duplicateRecords: 1, invalidLines: 0 });

test("dateKey applies the requested timezone", () => {
	const timestamp = Date.parse("2026-09-21T22:30:00Z");
	assert.equal(dateKey(timestamp, "UTC"), "2026-09-21");
	assert.equal(dateKey(timestamp, "Europe/Paris"), "2026-09-22");
});

test("daily reports use recorded costs and model breakdowns", () => {
	const report = buildReport(
		scan([
			record(),
			record({ id: "two", model: "other", inputTokens: 7, cost: 2.5 }),
			record({ id: "three", timestamp: Date.parse("2026-09-20T10:00:00Z"), cost: undefined }),
		]),
		{ kind: "daily", timezone: "UTC", sessionsDir: "/sessions", since: "2026-09-21" },
	);
	assert.equal(report.rows.length, 1);
	assert.equal(report.rows[0]?.totalCost, 3.75);
	assert.equal(report.rows[0]?.inputTokens, 17);
	assert.equal(report.rows[0]?.modelBreakdowns.length, 2);
	assert.equal(report.totals.unknownCostRecords, 0);
});

test("session reports group records by child session id", () => {
	const report = buildReport(
		scan([record(), record({ id: "two", sessionId: "child-session", project: "repo", cost: undefined })]),
		{ kind: "session", timezone: "UTC", sessionsDir: "/sessions" },
	);
	assert.deepEqual(
		report.rows.map((row) => row.key),
		["child-session", "session-1"],
	);
	assert.equal(report.totals.unknownCostRecords, 1);
});
