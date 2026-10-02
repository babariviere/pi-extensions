export type UsageSource = "assistant" | "tool" | "usage" | "compaction" | "branch_summary";

export interface AccountedUsage {
	source: UsageSource;
	kind?: string;
	provider: string;
	model: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost?: number;
}

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	totalCost: number;
}

type RecordLike = Record<string, unknown>;

function isRecord(value: unknown): value is RecordLike {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numeric(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function tokenCount(usage: RecordLike, current: string, legacy: string): number {
	const value = numeric(usage[current] ?? usage[legacy]);
	return value === undefined ? 0 : Math.max(0, Math.trunc(value));
}

function costTotal(value: unknown): number | undefined {
	const cost = numeric(value);
	if (cost !== undefined) return cost >= 0 ? cost : undefined;
	if (!isRecord(value)) return undefined;

	const total = numeric(value.total);
	if (total !== undefined) return total >= 0 ? total : undefined;

	const components = [value.input, value.output, value.cacheRead, value.cacheWrite]
		.map(numeric)
		.filter((component): component is number => component !== undefined && component >= 0);
	return components.length > 0 ? components.reduce((sum, component) => sum + component, 0) : undefined;
}

function accounted(
	usageValue: unknown,
	source: UsageSource,
	provider: string,
	model: string,
	kind?: string,
): AccountedUsage | undefined {
	if (!isRecord(usageValue)) return undefined;
	const cost = costTotal(usageValue.cost);
	return {
		source,
		...(kind === undefined ? {} : { kind }),
		provider,
		model,
		input: tokenCount(usageValue, "input", "inputTokens"),
		output: tokenCount(usageValue, "output", "outputTokens"),
		cacheRead: tokenCount(usageValue, "cacheRead", "cacheReadTokens"),
		cacheWrite: tokenCount(usageValue, "cacheWrite", "cacheWriteTokens"),
		...(cost === undefined ? {} : { cost }),
	};
}

/**
 * Extract billable usage from a Pi session entry. Tool, compaction, and branch
 * summary usage has no physical-model attribution, so it is grouped by source
 * rather than being assigned to the assistant model.
 */
export function extractAccountedUsage(entryValue: unknown): AccountedUsage | undefined {
	if (!isRecord(entryValue)) return undefined;
	if (entryValue.type === "message" && isRecord(entryValue.message)) {
		const message = entryValue.message;
		if (message.role === "assistant") {
			return accounted(
				message.usage,
				"assistant",
				typeof message.provider === "string" && message.provider ? message.provider : "unknown",
				typeof message.model === "string" && message.model ? message.model : "unknown",
			);
		}
		if (message.role === "toolResult") {
			const toolName = typeof message.toolName === "string" && message.toolName ? message.toolName : "unknown";
			return accounted(message.usage, "tool", "tool", toolName);
		}
		return undefined;
	}
	if (entryValue.type === "usage") {
		return accounted(
			entryValue.usage,
			"usage",
			typeof entryValue.provider === "string" && entryValue.provider ? entryValue.provider : "unknown",
			typeof entryValue.model === "string" && entryValue.model ? entryValue.model : "unknown",
			typeof entryValue.kind === "string" ? entryValue.kind : "unknown",
		);
	}
	if (entryValue.type === "compaction" || entryValue.type === "branch_summary") {
		const source = entryValue.type;
		return accounted(entryValue.usage, source, "unknown", source);
	}
	return undefined;
}

export function sumAccountedUsage(entries: Iterable<unknown>): UsageTotals {
	const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, totalCost: 0 };
	for (const entry of entries) {
		const usage = extractAccountedUsage(entry);
		if (!usage) continue;
		totals.input += usage.input;
		totals.output += usage.output;
		totals.cacheRead += usage.cacheRead;
		totals.cacheWrite += usage.cacheWrite;
		totals.totalCost += usage.cost ?? 0;
	}
	totals.totalTokens = totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
	return totals;
}
