import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	hasTerminalAssistantMessage,
	indexOutputOverride,
	normalizeOutputOverride,
	outputPathFor,
	planBatchOutputs,
	readLastAssistantText,
	resolveOutputOverride,
	resolveRunOutput,
} from "./output.ts";

function tmpFile(): string {
	return join(mkdtempSync(join(tmpdir(), "output-test-")), "out.md");
}

function sessionLine(role: string, content: unknown): string {
	return JSON.stringify({ type: "message", message: { role, content } });
}

test("resolveOutputOverride anchors a relative path to cwd and passes absolute through", () => {
	assert.equal(resolveOutputOverride("/repo", ".pi/goal/plan.md"), join("/repo", ".pi/goal/plan.md"));
	assert.equal(resolveOutputOverride("/repo", "/abs/plan.md"), "/abs/plan.md");
});

test("normalizeOutputOverride drops empty and boolean-ish literals", () => {
	assert.equal(normalizeOutputOverride(undefined), undefined);
	assert.equal(normalizeOutputOverride(""), undefined);
	assert.equal(normalizeOutputOverride("  "), undefined);
	assert.equal(normalizeOutputOverride("false"), undefined);
	assert.equal(normalizeOutputOverride("FALSE"), undefined);
	assert.equal(normalizeOutputOverride(" true "), undefined);
	assert.equal(normalizeOutputOverride("plan.md"), "plan.md");
	assert.equal(normalizeOutputOverride(" .pi/goal/plan.md "), ".pi/goal/plan.md");
});

test("indexOutputOverride inserts the index before the extension, preserving dir and shape", () => {
	assert.equal(indexOutputOverride("plan.md", 0), "plan-0.md");
	assert.equal(indexOutputOverride(".pi/goal/plan.md", 2), join(".pi/goal", "plan-2.md"));
	assert.equal(indexOutputOverride("/abs/out.md", 1), join("/abs", "out-1.md"));
	assert.equal(indexOutputOverride("report", 3), "report-3");
	assert.equal(indexOutputOverride(".env", 0), ".env-0");
});

test("planBatchOutputs normalizes every override and leaves a single run verbatim", () => {
	assert.deepEqual(planBatchOutputs(["plan.md"]), ["plan.md"]);
	assert.deepEqual(planBatchOutputs(["false"]), [undefined]);
	assert.deepEqual(planBatchOutputs([undefined]), [undefined]);
});

test("planBatchOutputs index-suffixes a parallel batch, skipping runs with no override", () => {
	assert.deepEqual(planBatchOutputs(["plan.md", "plan.md"]), ["plan-0.md", "plan-1.md"]);
	assert.deepEqual(planBatchOutputs([".pi/goal/p.md", undefined, "false"]), [
		join(".pi/goal", "p-0.md"),
		undefined,
		undefined,
	]);
});

test("outputPathFor resolves an override, else uses the run-dir default", () => {
	assert.equal(outputPathFor("/repo", "/runs/a-0.md", "plan.md"), join("/repo", "plan.md"));
	assert.equal(outputPathFor("/repo", "/runs/a-0.md", undefined), "/runs/a-0.md");
});

test("readLastAssistantText returns the last assistant message from the transcript", () => {
	const path = tmpFile();
	writeFileSync(
		path,
		[
			sessionLine("user", [{ type: "text", text: "review the diff" }]),
			sessionLine("assistant", [
				{ type: "thinking", thinking: "looking" },
				{ type: "text", text: "first pass" },
			]),
			sessionLine("toolResult", [{ type: "text", text: "diff output" }]),
			sessionLine("assistant", [
				{ type: "thinking", thinking: "done" },
				{ type: "text", text: "## Review\n" },
				{ type: "text", text: "**Verdict: PASS.**" },
			]),
			"",
		].join("\n"),
	);
	assert.equal(readLastAssistantText(path), "## Review\n**Verdict: PASS.**");
});

test("readLastAssistantText ignores assistant messages with no text (e.g. tool-only turns)", () => {
	const path = tmpFile();
	writeFileSync(
		path,
		[
			sessionLine("assistant", [{ type: "text", text: "the answer" }]),
			sessionLine("assistant", [{ type: "toolCall", name: "bash", arguments: {} }]),
			sessionLine("toolResult", [{ type: "text", text: "exit 0" }]),
		].join("\n"),
	);
	assert.equal(readLastAssistantText(path), "the answer");
});

test("readLastAssistantText returns undefined for a missing or textless transcript", () => {
	assert.equal(readLastAssistantText(tmpFile()), undefined);
	const path = tmpFile();
	writeFileSync(path, sessionLine("user", [{ type: "text", text: "hi" }]));
	assert.equal(readLastAssistantText(path), undefined);
});

test("resolveRunOutput reads the transcript first and persists it to outputPath", async () => {
	const session = tmpFile();
	writeFileSync(session, sessionLine("assistant", [{ type: "text", text: "from transcript" }]));
	const out = tmpFile();
	let fallbackCalls = 0;
	const r = await resolveRunOutput(out, session, {
		fallback: () => {
			fallbackCalls++;
			return "unused";
		},
		finishedCleanly: true,
	});
	assert.deepEqual(r, { output: "from transcript", ok: true, outputPath: out });
	assert.equal(fallbackCalls, 0); // fallback skipped when the transcript wins
	assert.equal(readFileSync(out, "utf-8"), "from transcript");
});

test("resolveRunOutput awaits the async fallback only when the transcript misses", async () => {
	const out = tmpFile();
	const r = await resolveRunOutput(out, tmpFile(), {
		fallback: () => Promise.resolve("from pane"),
		finishedCleanly: true,
	});
	assert.deepEqual(r, { output: "from pane", ok: true, outputPath: out });
	assert.equal(readFileSync(out, "utf-8"), "from pane");
});

test("resolveRunOutput is not ok when the run did not finish cleanly, even with output", async () => {
	const session = tmpFile();
	writeFileSync(session, sessionLine("assistant", [{ type: "text", text: "got text but crashed" }]));
	const r = await resolveRunOutput(tmpFile(), session, {
		fallback: () => undefined,
		finishedCleanly: false,
	});
	assert.equal(r.ok, false);
	assert.equal(r.output, "got text but crashed");
});

test("resolveRunOutput uses the placeholder and is not ok when no source yields text", async () => {
	const r = await resolveRunOutput(tmpFile(), tmpFile(), {
		fallback: () => undefined,
		finishedCleanly: true,
		placeholder: "(nothing)",
	});
	assert.deepEqual(r, { output: "(nothing)", ok: false });
});

test("resolveRunOutput creates missing parent directories for a caller output path", async () => {
	const session = tmpFile();
	writeFileSync(session, sessionLine("assistant", [{ type: "text", text: "the review" }]));
	const out = join(mkdtempSync(join(tmpdir(), "output-test-")), "night-2026-08-27", "reviewer.md");
	const r = await resolveRunOutput(out, session, { fallback: () => undefined, finishedCleanly: true });
	assert.equal(r.ok, true);
	assert.equal(r.outputPath, out);
	assert.equal(r.writeError, undefined);
	assert.equal(readFileSync(out, "utf-8"), "the review");
});

test("resolveRunOutput reports a write failure instead of claiming an outputPath", async () => {
	const session = tmpFile();
	writeFileSync(session, sessionLine("assistant", [{ type: "text", text: "the review" }]));
	// A file where a directory is expected: mkdir -p cannot fix this, so the
	// write must fail loudly rather than silently.
	const blocker = tmpFile();
	writeFileSync(blocker, "not a directory");
	const r = await resolveRunOutput(join(blocker, "nested", "out.md"), session, {
		fallback: () => undefined,
		finishedCleanly: true,
	});
	assert.equal(r.output, "the review");
	assert.equal(r.outputPath, undefined);
	assert.match(r.writeError ?? "", /could not write the result to/);
});

test("resolveRunOutput reports no outputPath when nothing was produced", async () => {
	const r = await resolveRunOutput(tmpFile(), tmpFile(), { fallback: () => undefined, finishedCleanly: true });
	assert.equal(r.outputPath, undefined);
	assert.equal(r.writeError, undefined);
});

test("hasTerminalAssistantMessage is false for a transcript ending mid-turn", () => {
	const dir = mkdtempSync(join(tmpdir(), "turn-boundary-"));
	const path = join(dir, "session.jsonl");
	// The failure this guards: the child had just received tool results and was
	// about to generate, while the pane read as idle.
	writeFileSync(
		path,
		[
			JSON.stringify({ type: "session", id: "s" }),
			JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "task" }] } }),
			JSON.stringify({
				type: "message",
				message: { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "let me grep" }] },
			}),
			JSON.stringify({
				type: "message",
				message: { role: "toolResult", content: [{ type: "text", text: "hits" }] },
			}),
		].join("\n"),
	);
	assert.equal(hasTerminalAssistantMessage(path), false);
});

test("hasTerminalAssistantMessage is false when the last assistant turn stopped to call a tool", () => {
	const dir = mkdtempSync(join(tmpdir(), "turn-boundary-"));
	const path = join(dir, "session.jsonl");
	writeFileSync(
		path,
		JSON.stringify({
			type: "message",
			message: { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "calling a tool" }] },
		}),
	);
	assert.equal(hasTerminalAssistantMessage(path), false);
});

test("hasTerminalAssistantMessage is true for a final assistant message", () => {
	const dir = mkdtempSync(join(tmpdir(), "turn-boundary-"));
	const path = join(dir, "session.jsonl");
	writeFileSync(
		path,
		[
			JSON.stringify({
				type: "message",
				message: { role: "toolResult", content: [{ type: "text", text: "hits" }] },
			}),
			JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					stopReason: "endTurn",
					content: [{ type: "text", text: "## Research\nfindings" }],
				},
			}),
			// Trailing non-message records must not hide the terminal turn.
			JSON.stringify({ type: "thinking_level_change", thinkingLevel: "off" }),
		].join("\n"),
	);
	assert.equal(hasTerminalAssistantMessage(path), true);
});

test("hasTerminalAssistantMessage is false for a missing or empty transcript", () => {
	const dir = mkdtempSync(join(tmpdir(), "turn-boundary-"));
	assert.equal(hasTerminalAssistantMessage(join(dir, "nope.jsonl")), false);
	const empty = join(dir, "empty.jsonl");
	writeFileSync(empty, "");
	assert.equal(hasTerminalAssistantMessage(empty), false);
});
