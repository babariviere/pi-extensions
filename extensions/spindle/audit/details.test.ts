import assert from "node:assert/strict";
import { test } from "node:test";

import {
	createSpindlePersistedExecutionDetails,
	readSpindleExecutionRenderDetails,
	SPINDLE_EXECUTION_DETAILS_MAX_BYTES,
} from "./details.ts";
import type { SpindleExecutionTraceV1 } from "./trace.ts";

const trace = (operations: SpindleExecutionTraceV1["operations"] = []): SpindleExecutionTraceV1 => ({
	version: 1,
	outcome: "succeeded",
	startedAt: 0,
	endedAt: 1,
	phases: [],
	operations,
	counts: { operations: operations.length, droppedOperations: 0, droppedValues: 0 },
});

test("τ keys round-trip through the persisted details", () => {
	const details = createSpindlePersistedExecutionDetails({
		success: true,
		trace: trace(),
		state: [{ key: "index", bytes: 20002, preview: '{"files":["a.ts"]}' }],
	});
	assert.deepEqual(details.state, [{ key: "index", bytes: 20002, preview: '{"files":["a.ts"]}' }]);
	assert.deepEqual(readSpindleExecutionRenderDetails(details).state, details.state);
});

test("an empty scratchpad adds no field at all", () => {
	const details = createSpindlePersistedExecutionDetails({ success: true, trace: trace(), state: [] });
	assert.equal(details.state, undefined);
	assert.equal(readSpindleExecutionRenderDetails(details).state, undefined);
});

test("previews are bounded per key", () => {
	const details = createSpindlePersistedExecutionDetails({
		success: true,
		trace: trace(),
		state: [{ key: "big", bytes: 1_000_000, preview: "x".repeat(10_000) }],
	});
	assert.ok((details.state![0]!.preview?.length ?? 0) <= 200);
});

test("previews are dropped before trace operations when over budget", () => {
	const operations = Array.from({ length: 40 }, (_value, index) => ({
		id: `op-${index}`,
		ref: "pi.read",
		provider: "pi",
		action: "read",
		outcome: "succeeded" as const,
		startedAt: 0,
		endedAt: 1,
		args: { path: "y".repeat(20_000) },
	}));
	const details = createSpindlePersistedExecutionDetails({
		success: true,
		trace: trace(operations),
		state: Array.from({ length: 16 }, (_value, index) => ({
			key: `k${index}`,
			bytes: 10,
			preview: "z".repeat(200),
		})),
	});
	assert.ok(Buffer.byteLength(JSON.stringify(details), "utf8") <= SPINDLE_EXECUTION_DETAILS_MAX_BYTES);
	// Keys and sizes survive; only the convenience previews are shed.
	assert.equal(details.state?.length, 16);
	assert.ok(details.state?.every((entry) => entry.preview === undefined));
	assert.ok(details.trace.operations.length > 0);
});

test("a malformed state field is ignored rather than rendered", () => {
	const render = readSpindleExecutionRenderDetails({
		trace: trace(),
		state: [{ key: "ok", bytes: 1 }, { key: 5, bytes: 1 }, "nope", { key: "x", bytes: "big" }],
	});
	assert.deepEqual(render.state, [{ key: "ok", bytes: 1 }]);
});
