import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { SpindleEvaluationInputError, evaluateSpindleJsonl, parseSpindleEvaluationJsonl } from "./index.ts";

const metrics = (overrides: Record<string, unknown> = {}) => ({
	version: 1,
	profile: "neutral",
	routes: {
		edit: { attempts: 1, successes: 1, failures: 0 },
		write: { attempts: 0, successes: 0, failures: 0 },
		applyPatch: { attempts: 0, successes: 0, failures: 0 },
		scripted: { attempts: 0, successes: 0, failures: 0 },
	},
	knownFiles: ["src/a.ts"],
	repeatedAttempts: [],
	guardRefusals: 0,
	durationMs: 100,
	outcome: "succeeded",
	...overrides,
});

const record = (variant: string, task: string, overrides: Record<string, unknown> = {}) => ({
	version: 1,
	variant,
	task,
	passed: true,
	metrics: metrics(),
	...overrides,
});

const jsonl = (records: unknown[]): string => records.map((entry) => JSON.stringify(entry)).join("\n");

test("evaluation summaries are deterministic and compare every collected metric", () => {
	const control = record("control", "task-a", { toolCalls: 3, tokens: { input: 100, output: 20 } });
	const candidate = record("candidate", "task-b", {
		passed: false,
		metrics: metrics({
			routes: {
				edit: { attempts: 2, successes: 1, failures: 1 },
				write: { attempts: 0, successes: 0, failures: 0 },
				applyPatch: { attempts: 1, successes: 1, failures: 0 },
				scripted: { attempts: 1, successes: 0, failures: 1 },
			},
			knownFiles: ["src/a.ts", "src/b.ts"],
			repeatedAttempts: [{ path: "src/a.ts", attempts: 2 }],
			guardRefusals: 1,
			durationMs: 160,
			outcome: "failed",
		}),
		toolCalls: 6,
		tokens: { input: 130, output: 40 },
	});
	const forward = evaluateSpindleJsonl(jsonl([control, candidate]), { baseline: "control" });
	const reversed = evaluateSpindleJsonl(jsonl([candidate, control]), { baseline: "control" });

	assert.deepEqual(forward, reversed);
	assert.equal(forward.variants[0].variant, "control");
	assert.deepEqual(forward.variants[1].routes.applyPatch, {
		attempts: 1,
		failures: 0,
		attemptsPerRun: 1,
		failuresPerRun: 0,
	});
	assert.deepEqual(forward.variants[1].repeatedEdits, {
		files: 1,
		attempts: 2,
		excessAttempts: 1,
		meanExcessAttemptsPerRun: 1,
	});
	assert.deepEqual(forward.comparison.candidateMinusBaseline, {
		taskPassRate: -1,
		routes: {
			edit: { attemptsPerRun: 1, failuresPerRun: 1 },
			write: { attemptsPerRun: 0, failuresPerRun: 0 },
			applyPatch: { attemptsPerRun: 1, failuresPerRun: 0 },
			scripted: { attemptsPerRun: 1, failuresPerRun: 1 },
		},
		guardRefusalsPerRun: 1,
		repeatedEditExcessAttemptsPerRun: 1,
		knownFilesPerRun: 1,
		durationMsPerRun: 60,
		toolCallsPerMeasuredRun: 3,
		tokensPerMeasuredRun: { input: 30, output: 20, total: 50 },
	});
});

test("optional usage counters report measurement coverage", () => {
	const summary = evaluateSpindleJsonl(
		jsonl([
			record("a", "one", { toolCalls: 2 }),
			record("a", "two"),
			record("b", "one", { tokens: { input: 10, output: 5 } }),
		]),
	);

	assert.deepEqual(summary.variants[0].toolCalls, { measuredRuns: 1, total: 2, meanPerRun: 2 });
	assert.equal(summary.variants[0].tokens, undefined);
	assert.equal(summary.variants[1].toolCalls, undefined);
	assert.deepEqual(summary.variants[1].tokens, {
		measuredRuns: 1,
		input: { total: 10, meanPerRun: 10 },
		output: { total: 5, meanPerRun: 5 },
		total: { total: 15, meanPerRun: 15 },
	});
	assert.equal(summary.comparison.candidateMinusBaseline.toolCallsPerMeasuredRun, undefined);
	assert.equal(summary.comparison.candidateMinusBaseline.tokensPerMeasuredRun, undefined);
});

test("JSONL validation rejects malformed metrics and duplicate assignments with line locations", () => {
	const invalid = record("a", "one", {
		metrics: metrics({
			routes: {
				edit: { attempts: 1, successes: 1, failures: 1 },
				write: { attempts: 0, successes: 0, failures: 0 },
				applyPatch: { attempts: 0, successes: 0, failures: 0 },
				scripted: { attempts: 0, successes: 0, failures: 0 },
			},
		}),
	});
	assert.throws(
		() => parseSpindleEvaluationJsonl(jsonl([invalid])),
		(error: unknown) =>
			error instanceof SpindleEvaluationInputError &&
			/line 1\.metrics\.routes\.edit: successes plus failures must equal attempts/.test(error.message),
	);
	assert.throws(
		() => parseSpindleEvaluationJsonl(jsonl([record("a", "one"), record("a", "one")])),
		/line 2: duplicate variant and task assignment/,
	);
	assert.throws(
		() =>
			parseSpindleEvaluationJsonl(jsonl([record("a", "one", { metrics: metrics({ droppedRepeatedAttempts: 1 }) })])),
		/cannot evaluate truncated repeated-edit metrics/,
	);
});

test("representative corpus covers editing and recovery tasks for both variants", () => {
	const corpus = readFileSync(new URL("./corpus.jsonl", import.meta.url), "utf8");
	const records = parseSpindleEvaluationJsonl(corpus);
	const expectedTasks = [
		"context-conflict-recovery",
		"coordinated-multi-file-change",
		"create",
		"focused-update",
		"malformed-patch-recovery",
		"move-delete",
		"sandbox-denial",
	];
	const variants = [...new Set(records.map((entry) => entry.variant))].sort();

	assert.deepEqual(variants, ["edit-first", "patch-first"]);
	for (const variant of variants) {
		assert.deepEqual(
			records
				.filter((entry) => entry.variant === variant)
				.map((entry) => entry.task)
				.sort(),
			expectedTasks,
		);
	}
	const sandboxRecords = records.filter((entry) => entry.task === "sandbox-denial");
	assert.ok(sandboxRecords.every((entry) => entry.passed && entry.metrics.outcome === "failed"));
	assert.equal(evaluateSpindleJsonl(corpus, { baseline: "edit-first" }).records, 14);
});
