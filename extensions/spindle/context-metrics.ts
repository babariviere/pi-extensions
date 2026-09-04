import type { SpindleCallAudit } from "./core/action-registry.ts";

export const CONTEXT_READ_WARNING_BYTES = 50 * 1024;

export interface SpindleContextMetrics {
	readCalls: number;
	unboundedReadCalls: number;
	readResultChars: number;
	largeUnboundedReadCalls: number;
}

const numeric = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;

export const summarizeContextMetrics = (audits: readonly SpindleCallAudit[]): SpindleContextMetrics => {
	const metrics: SpindleContextMetrics = {
		readCalls: 0,
		unboundedReadCalls: 0,
		readResultChars: 0,
		largeUnboundedReadCalls: 0,
	};
	for (const audit of audits) {
		if (audit.ref !== "pi.read" || audit.success !== true) continue;
		metrics.readCalls++;
		const limit = numeric(audit.args?.limit);
		const unbounded = limit === undefined;
		if (unbounded) metrics.unboundedReadCalls++;
		const chars = audit.resultChars ?? 0;
		metrics.readResultChars += chars;
		if (unbounded && chars >= CONTEXT_READ_WARNING_BYTES) metrics.largeUnboundedReadCalls++;
	}
	return metrics;
};

export const contextReadWarning = (metrics: SpindleContextMetrics): string | undefined => {
	if (metrics.largeUnboundedReadCalls === 0) return undefined;
	return `Context advisory: ${metrics.largeUnboundedReadCalls} large unbounded pi.read call${
		metrics.largeUnboundedReadCalls === 1 ? "" : "s"
	} completed. Search with pi.grep or pi.find, then use pi.read with offset and limit for subsequent inspection.`;
};
