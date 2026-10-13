import assert from "node:assert/strict";
import { test } from "node:test";
import { bar, compactNumber, formatCost, renderReport } from "./render.ts";
import { buildReport } from "./report.ts";
import type { UsageRecord } from "./types.ts";

const record = (overrides: Partial<UsageRecord> = {}): UsageRecord => ({
	id: "one",
	sessionId: "session-1",
	project: "project",
	timestamp: Date.parse("2026-09-21T10:00:00Z"),
	provider: "provider",
	model: "model",
	inputTokens: 1_234_567,
	outputTokens: 5_000,
	cacheReadTokens: 20,
	cacheWriteTokens: 0,
	cost: 12.5,
	sourcePath: "/sessions/one.jsonl",
	...overrides,
});

test("compact numbers and costs stay short and readable", () => {
	assert.equal(compactNumber(950), "950");
	assert.equal(compactNumber(12_345), "12.3K");
	assert.equal(compactNumber(999_999), "1.00M");
	assert.equal(compactNumber(4_560_000), "4.56M");
	assert.equal(compactNumber(1_310_000_000), "1.31B");
	assert.equal(formatCost(1234.5), "$1,234.50");
	assert.equal(formatCost(0.001), "<$0.01");
	assert.equal(formatCost(0), "$0.00");
	assert.equal(formatCost(2, 1), "$2.00*");
	assert.equal(bar(10, 10, 4), "████");
	assert.equal(bar(1, 8, 1), "▏");
	assert.equal(bar(0, 10), "");
});

test("renderReport draws an aligned boxed table with breakdowns and totals", () => {
	const report = buildReport(
		{
			records: [
				record(),
				record({ id: "two", model: "other", cost: undefined }),
				record({ id: "three", timestamp: Date.parse("2026-09-22T10:00:00Z"), cost: 6.25 }),
			],
			files: 1,
			duplicateRecords: 0,
			invalidLines: 0,
			pilotDatabases: 3,
			unreadableDatabases: 1,
		},
		{ kind: "daily", timezone: "UTC", sessionsDir: "/sessions" },
	);
	const output = renderReport(report, { breakdown: true });
	const lines = output.trimEnd().split("\n");
	const table = lines.filter((line) => /^[╭├│╰]/.test(line));
	assert.ok(
		table.every((line) => [...line].length === [...table[0]!].length),
		"rows share one width",
	);
	assert.match(output, /│ Date +│ Input │ Output │ Cache Read │ Cache Write │ Total │ +Cost │ Share +│/);
	assert.match(output, /│ 2026-09-21 +│ 2\.47M │ +10\.0K │/);
	assert.match(output, /├─ provider\/model/);
	assert.match(output, /└─ provider\/other .*\$0\.00\*/);
	assert.match(output, /│ Total .*\$18\.75\* │/);
	assert.match(output, /██████████/);
	assert.match(output, /3 Pilot databases · 1 pi session file · 0 duplicate records ignored/);
	assert.match(output, /1 Pilot database could not be read/);
	assert.doesNotMatch(output, /\x1b\[/);
	assert.match(renderReport(report, { color: true }), /\x1b\[1m/);
});

test("renderReport truncates long labels to fit the terminal width", () => {
	const report = buildReport(
		{
			records: [record({ sessionTitle: "A very long session title that keeps going and going" })],
			files: 1,
			duplicateRecords: 0,
			invalidLines: 0,
		},
		{ kind: "session", timezone: "UTC", sessionsDir: "/sessions" },
	);
	const output = renderReport(report, { width: 100 });
	const widest = Math.max(...output.split("\n").map((line) => [...line].length));
	assert.ok(widest <= 100, `table width ${widest} exceeds 100`);
	assert.match(output, /project · A very long.*…/);
});
