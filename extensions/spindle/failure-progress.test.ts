import assert from "node:assert/strict";
import { test } from "node:test";

import type { SpindleExecutionTraceV1 } from "./audit/trace.ts";
import { formatFailureProgress } from "./failure-progress.ts";

const trace = (overrides: Partial<SpindleExecutionTraceV1>): SpindleExecutionTraceV1 =>
	({
		outcome: "failed",
		operations: [],
		...overrides,
	}) as SpindleExecutionTraceV1;

const operation = (ref: string, outcome: string, path?: string) =>
	({ ref, outcome, args: path === undefined ? {} : { path } }) as never;

test("a successful execution reports no progress", () => {
	assert.equal(
		formatFailureProgress(trace({ outcome: "succeeded", operations: [operation("pi.write", "succeeded")] })),
		undefined,
	);
});

test("a failure with no completed call reports nothing", () => {
	assert.equal(formatFailureProgress(trace({ operations: [operation("pi.read", "failed")] })), undefined);
});

test("completed calls are named with their paths", () => {
	const text = formatFailureProgress(
		trace({
			operations: [operation("pi.write", "succeeded", "/tmp/a.txt"), operation("pi.read", "failed", "/tmp/b.txt")],
		}),
	);
	assert.match(String(text), /pi\.write\(\/tmp\/a\.txt\)/);
	assert.match(String(text), /inspect before repeating mutations/);
});

test("the completed-call list is bounded", () => {
	const operations = Array.from({ length: 12 }, (_value, index) => operation(`pi.write`, "succeeded", `/tmp/${index}`));
	const text = String(formatFailureProgress(trace({ operations })));
	assert.match(text, /\+4 more/);
});
