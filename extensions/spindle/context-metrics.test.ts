import assert from "node:assert/strict";
import test from "node:test";
import { contextReadWarning, summarizeContextMetrics } from "./context-metrics.ts";
import type { SpindleCallAudit } from "./core/action-registry.ts";

const read = (args: Record<string, unknown>, resultChars: number): SpindleCallAudit => ({
	ref: "pi.read",
	nestedToolCallId: "call",
	startedAt: 0,
	success: true,
	args,
	resultChars,
});

test("retrieval evaluation counts bounded and unbounded reads", () => {
	const metrics = summarizeContextMetrics([
		read({ path: "src/a.ts", limit: 120 }, 3_000),
		read({ path: "src/generated.ts" }, 60 * 1024),
		{ ref: "pi.grep", nestedToolCallId: "grep", startedAt: 0, success: true, resultChars: 500 },
	]);
	assert.deepEqual(metrics, {
		readCalls: 2,
		unboundedReadCalls: 1,
		readResultChars: 3_000 + 60 * 1024,
		largeUnboundedReadCalls: 1,
	});
	assert.match(contextReadWarning(metrics) ?? "", /large unbounded pi.read/);
});

test("retrieval evaluation accepts bounded reads without a warning", () => {
	const metrics = summarizeContextMetrics([read({ path: "src/a.ts", offset: 1, limit: 200 }, 80 * 1024)]);
	assert.equal(metrics.largeUnboundedReadCalls, 0);
	assert.equal(contextReadWarning(metrics), undefined);
});
