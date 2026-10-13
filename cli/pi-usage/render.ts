import type { ModelBreakdown, UsageReport } from "./types.ts";

export interface RenderOptions {
	/** Show provider/model rows beneath each period or session. */
	breakdown?: boolean;
	/** Emit ANSI colors. */
	color?: boolean;
	/** Terminal width; long labels are truncated so the table fits. */
	width?: number;
}

type Align = "left" | "right";
type Style = "header" | "row" | "model" | "total";

interface Column {
	title: string;
	align: Align;
}

interface Line {
	cells: string[];
	style: Style;
	/** Draw a thin rule above this line. */
	ruleAbove?: boolean;
}

const ANSI = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	cyan: "\x1b[36m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
} as const;

const BAR_WIDTH = 10;
const MIN_LABEL_WIDTH = 12;
const MAX_LABEL_WIDTH = 56;
const COST_COLUMN = 6;
const SHARE_COLUMN = 7;

/** Compact token counts: 950, 12.3K, 4.56M, 1.20B. */
export function compactNumber(value: number): string {
	const abs = Math.abs(value);
	if (abs < 1_000) return String(Math.round(value));
	const [divisor, suffix] = abs < 999_500 ? [1e3, "K"] : abs < 999_500_000 ? [1e6, "M"] : [1e9, "B"];
	const scaled = value / divisor;
	const digits = Math.abs(scaled) < 9.995 ? 2 : Math.abs(scaled) < 99.95 ? 1 : 0;
	return `${scaled.toFixed(digits)}${suffix}`;
}

export function formatCost(value: number, unknown = 0): string {
	const amount =
		value > 0 && value < 0.005
			? "<$0.01"
			: `$${new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)}`;
	return `${amount}${unknown > 0 ? "*" : ""}`;
}

/** Horizontal bar with eighth-block precision, relative to the largest value. */
export function bar(value: number, max: number, width = BAR_WIDTH): string {
	if (!(max > 0) || !(value > 0)) return "";
	const eighths = Math.max(1, Math.round((value / max) * width * 8));
	const partial = eighths % 8;
	return "█".repeat(Math.floor(eighths / 8)) + (partial ? "▏▎▍▌▋▊▉"[partial - 1]! : "");
}

const length = (value: string): number => [...value].length;

function truncate(value: string, width: number): string {
	const chars = [...value];
	return chars.length <= width ? value : `${chars.slice(0, Math.max(0, width - 1)).join("")}…`;
}

function pad(value: string, width: number, align: Align): string {
	const fill = " ".repeat(Math.max(0, width - length(value)));
	return align === "right" ? fill + value : value + fill;
}

function usageCells(label: string, usage: ModelBreakdown): string[] {
	return [
		label,
		compactNumber(usage.inputTokens),
		compactNumber(usage.outputTokens),
		compactNumber(usage.cacheReadTokens),
		compactNumber(usage.cacheWriteTokens),
		compactNumber(usage.totalTokens),
		formatCost(usage.totalCost, usage.unknownCostRecords),
	];
}

function count(value: number, singular: string): string {
	return `${new Intl.NumberFormat("en-US").format(value)} ${value === 1 ? singular : `${singular}s`}`;
}

export function renderReport(report: UsageReport, options: RenderOptions = {}): string {
	const { breakdown = false, color = false, width } = options;
	const paint = (value: string, ...codes: string[]): string =>
		color && codes.length > 0 && value.length > 0 ? `${codes.join("")}${value}${ANSI.reset}` : value;

	const heading = report.kind === "session" ? "Session" : report.kind === "monthly" ? "Month" : "Date";
	const columns: Column[] = [
		{ title: heading, align: "left" },
		{ title: "Input", align: "right" },
		{ title: "Output", align: "right" },
		{ title: "Cache Read", align: "right" },
		{ title: "Cache Write", align: "right" },
		{ title: "Total", align: "right" },
		{ title: "Cost", align: "right" },
		{ title: "Share", align: "left" },
	];

	const maxCost = Math.max(0, ...report.rows.map((row) => row.totalCost));
	const lines: Line[] = [{ cells: columns.map((column) => column.title), style: "header" }];
	for (const [index, row] of report.rows.entries()) {
		lines.push({
			cells: [...usageCells(row.label, row), bar(row.totalCost, maxCost)],
			style: "row",
			ruleAbove: breakdown && index > 0,
		});
		if (!breakdown) continue;
		for (const [modelIndex, model] of row.modelBreakdowns.entries()) {
			const branch = modelIndex === row.modelBreakdowns.length - 1 ? "└─" : "├─";
			lines.push({
				cells: [...usageCells(`${branch} ${model.provider}/${model.model}`, model), ""],
				style: "model",
			});
		}
	}
	lines.push({ cells: [...usageCells("Total", report.totals), ""], style: "total", ruleAbove: true });

	const widths = columns.map((_, index) => Math.max(...lines.map((line) => length(line.cells[index] ?? ""))));
	widths[0] = Math.min(widths[0]!, MAX_LABEL_WIDTH);
	widths[SHARE_COLUMN] = Math.max(widths[SHARE_COLUMN]!, BAR_WIDTH);
	if (width !== undefined) {
		// Each cell is padded by one space on both sides and followed by a border, plus the leading border.
		const tableWidth = widths.reduce((sum, value) => sum + value + 3, 1);
		if (tableWidth > width) widths[0] = Math.max(MIN_LABEL_WIDTH, widths[0]! - (tableWidth - width));
	}

	const rule = (left: string, middle: string, right: string): string =>
		paint(`${left}${widths.map((value) => "─".repeat(value + 2)).join(middle)}${right}`, ANSI.dim);
	const separator = paint("│", ANSI.dim);
	const render = (line: Line): string => {
		const cells = line.cells.map((cell, index) => {
			const text = pad(index === 0 ? truncate(cell, widths[0]!) : cell, widths[index]!, columns[index]!.align);
			if (line.style === "header") return paint(text, ANSI.bold, ANSI.cyan);
			if (line.style === "model") return paint(text, ANSI.dim);
			if (line.style === "total") return paint(text, ANSI.bold, ...(index === COST_COLUMN ? [ANSI.green] : []));
			if (index === COST_COLUMN) return paint(text, ANSI.green);
			if (index === SHARE_COLUMN) return paint(text, ANSI.yellow);
			return text;
		});
		return `${separator} ${cells.join(` ${separator} `)} ${separator}`;
	};

	const output = [rule("╭", "┬", "╮")];
	for (const [index, line] of lines.entries()) {
		if (index === 1 || line.ruleAbove) output.push(rule("├", "┼", "┤"));
		output.push(render(line));
	}
	output.push(rule("╰", "┴", "╯"));

	const sources = [
		report.pilotDatabases === undefined ? undefined : count(report.pilotDatabases, "Pilot database"),
		report.files > 0 || report.pilotDatabases === undefined ? count(report.files, "pi session file") : undefined,
	].filter((value): value is string => value !== undefined);
	const notes = [
		`${sources.join(" · ")} · ${count(report.duplicateRecords, "duplicate record")} ignored`,
		report.unreadableDatabases
			? `${count(report.unreadableDatabases, "Pilot database")} could not be read (locked or corrupt)`
			: undefined,
		report.totals.unknownCostRecords > 0
			? `* ${count(report.totals.unknownCostRecords, "usage record")} had no recorded cost (counted as $0.00)`
			: undefined,
		report.invalidLines > 0 ? `${count(report.invalidLines, "invalid record")} ignored` : undefined,
	].filter((note): note is string => note !== undefined);
	return `${output.join("\n")}\n${notes.map((note) => paint(note, ANSI.dim)).join("\n")}\n`;
}
