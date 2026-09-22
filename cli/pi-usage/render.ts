import type { ModelBreakdown, UsageReport } from "./types.ts";

function number(value: number): string {
	return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function cost(value: number, unknown: number): string {
	return `$${value.toFixed(2)}${unknown > 0 ? "*" : ""}`;
}

function table(headers: string[], rows: string[][]): string {
	const widths = headers.map((header, index) =>
		Math.max(header.length, ...rows.map((row) => (row[index] ?? "").length)),
	);
	const line = (row: string[]): string =>
		row
			.map((cell, index) => cell.padEnd(widths[index]!))
			.join("  ")
			.trimEnd();
	return [line(headers), widths.map((width) => "-".repeat(width)).join("  "), ...rows.map(line)].join("\n");
}

function values(label: string, usage: ModelBreakdown): string[] {
	return [
		label,
		number(usage.inputTokens),
		number(usage.outputTokens),
		number(usage.cacheReadTokens),
		number(usage.cacheWriteTokens),
		number(usage.totalTokens),
		cost(usage.totalCost, usage.unknownCostRecords),
	];
}

export function renderReport(report: UsageReport, breakdown: boolean): string {
	const heading = report.kind === "session" ? "Session" : report.kind === "monthly" ? "Month" : "Date";
	const headers = [heading, "Input", "Output", "Cache Read", "Cache Write", "Total", "Cost"];
	const rows: string[][] = [];
	for (const row of report.rows) {
		rows.push(values(row.label, row));
		if (breakdown) {
			for (const model of row.modelBreakdowns) rows.push(values(`  ${model.provider}/${model.model}`, model));
		}
	}
	rows.push(values("Total", report.totals));
	const notes = [
		`${report.files} session files, ${report.duplicateRecords} duplicate messages ignored`,
		report.totals.unknownCostRecords > 0
			? `* ${report.totals.unknownCostRecords} messages had no recorded cost and contribute $0.00`
			: undefined,
		report.invalidLines > 0 ? `${report.invalidLines} invalid JSONL lines ignored` : undefined,
	].filter((note): note is string => note !== undefined);
	return `${table(headers, rows)}\n\n${notes.join("\n")}\n`;
}
