import assert from "node:assert/strict";
import { test } from "node:test";

import {
	CODE_MODE_EXECUTION_DETAILS_MAX_BYTES,
	createCodeModePersistedExecutionDetails,
	readCodeModeExecutionRenderDetails,
} from "./details.ts";
import { CodeModeExecutionTraceRecorder } from "./trace.ts";

const metricTrace = () => {
	const recorder = new CodeModeExecutionTraceRecorder();
	const firstEdit = recorder.issueCall("pi.edit", {
		path: "src/a.ts",
		edits: [{ oldText: "private source", newText: "replacement source" }],
	});
	firstEdit.succeed({ ok: true, output: "private result" });
	const retry = recorder.issueCall("pi.edit", { path: "src/a.ts", edits: [{ oldText: "x", newText: "y" }] });
	retry.fail("guard", new Error("credential=private"));
	const write = recorder.issueCall("pi.write", { path: "src/b.ts", content: "private source" });
	write.succeed({ created: true, output: "private result" });
	const patch = recorder.issueCall("pi.applyPatch", { patch: "private patch body" });
	patch.succeed({
		content: [{ type: "text", text: "private result" }],
		details: {
			changes: [
				{ kind: "add", path: "src/c.ts", source: "private source" },
				{ kind: "move", path: "src/d.ts", moveTo: "src/e.ts", prompt: "private prompt" },
			],
		},
	});
	const failedPatch = recorder.issueCall("pi.applyPatch", {
		patch: "*** Begin Patch\n*** Update File: src/c.ts\n@@\n-private patch body\n+replacement\n*** End Patch",
	});
	failedPatch.fail("invoke", new Error("private error"));
	const bash = recorder.issueCall("pi.bash", { command: "npm test" });
	bash.succeed({ ok: true });
	const exec = recorder.issueCall("pi.exec", { argv: ["npm", "run", "typecheck"] });
	exec.fail("invoke", new Error("private error"));
	return recorder.seal("failed", []);
};

test("persisted edit metrics are deterministic aggregates of the projected trace", () => {
	const trace = metricTrace();
	const input = { success: false, trace, elapsedMs: 123.6, editProfile: "openai" as const };
	const first = createCodeModePersistedExecutionDetails(input);
	const second = createCodeModePersistedExecutionDetails(input);

	assert.deepEqual(first.editMetrics, second.editMetrics);
	assert.deepEqual(first.editMetrics, {
		version: 1,
		profile: "openai",
		routes: {
			edit: { attempts: 2, successes: 1, failures: 1 },
			write: { attempts: 1, successes: 1, failures: 0 },
			applyPatch: { attempts: 2, successes: 1, failures: 1 },
			scripted: { attempts: 2, successes: 1, failures: 1 },
		},
		knownFiles: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"],
		repeatedAttempts: [
			{ path: "src/a.ts", attempts: 2 },
			{ path: "src/c.ts", attempts: 2 },
		],
		guardRefusals: 1,
		durationMs: 124,
		outcome: "failed",
	});
});

test("persisted edit metrics retain no edit bodies, prompts, credentials, or raw errors", () => {
	const details = createCodeModePersistedExecutionDetails({
		success: false,
		trace: metricTrace(),
		elapsedMs: 1,
		editProfile: "anthropic",
	});
	const serializedDetails = JSON.stringify(details);
	for (const privateText of [
		"private source",
		"replacement source",
		"private patch body",
		"private prompt",
		"credential=private",
		"private error",
	]) {
		assert.doesNotMatch(serializedDetails, new RegExp(privateText));
	}
	assert.deepEqual(Object.keys(details.editMetrics ?? {}).sort(), [
		"durationMs",
		"guardRefusals",
		"knownFiles",
		"outcome",
		"profile",
		"repeatedAttempts",
		"routes",
		"version",
	]);
});

test("rendering remains compatible with details created before edit metrics", () => {
	const trace = new CodeModeExecutionTraceRecorder().seal("succeeded", ["done"]);
	const current = readCodeModeExecutionRenderDetails({ success: true, trace });
	assert.deepEqual(current.phases, ["done"]);
	assert.deepEqual(current.audits, []);

	const legacy = readCodeModeExecutionRenderDetails({
		success: true,
		phases: ["legacy"],
		audits: [{ ref: "pi.write", success: true, args: { path: "old.ts" } }],
	});
	assert.deepEqual(legacy.phases, ["legacy"]);
	assert.equal(legacy.audits[0]?.ref, "pi.write");
});

test("edit metrics and final details stay bounded at the details size cap", () => {
	const recorder = new CodeModeExecutionTraceRecorder();
	for (let index = 0; index < 2_048; index++) {
		const suffix = String(index).padStart(4, "0");
		const operation = recorder.issueCall("pi.write", { path: `src/${suffix}-${"x".repeat(450)}.ts` });
		operation.succeed({ created: true });
	}
	const details = createCodeModePersistedExecutionDetails({
		success: true,
		trace: recorder.seal("succeeded", []),
		elapsedMs: Number.POSITIVE_INFINITY,
		editProfile: "neutral",
	});

	assert.ok(Buffer.byteLength(JSON.stringify(details), "utf8") <= CODE_MODE_EXECUTION_DETAILS_MAX_BYTES);
	assert.equal(details.editMetrics?.knownFiles.length, 128);
	assert.ok((details.editMetrics?.droppedKnownFiles ?? 0) > 0);
	assert.equal(details.editMetrics?.durationMs, 0);
});
