import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readLastAssistantText, resolveRunOutput, type RunOutcome, waitForRunCompletion } from "./run.ts";

function tmpFile(): string {
	return join(mkdtempSync(join(tmpdir(), "run-test-")), "out.md");
}

function sessionLine(role: string, content: unknown): string {
	return JSON.stringify({ type: "message", message: { role, content } });
}

test("waitForRunCompletion returns 'stable' once the output file stops changing", async () => {
	const path = tmpFile();
	writeFileSync(path, "final content");
	const outcome = await waitForRunCompletion(path, { timeoutMs: 5000, intervalMs: 20 });
	assert.equal(outcome, "stable");
});

test("waitForRunCompletion returns 'gone' when the agent signal reports a killed pane", async () => {
	const path = tmpFile(); // never created
	const outcome = await waitForRunCompletion(path, {
		timeoutMs: 5000,
		intervalMs: 20,
		graceMs: 60,
		agentSignal: Promise.resolve<"gone">("gone"),
	});
	assert.equal(outcome, "gone");
});

test("waitForRunCompletion returns 'finished' when the agent idles without writing", async () => {
	const path = tmpFile(); // never created
	const outcome = await waitForRunCompletion(path, {
		timeoutMs: 5000,
		intervalMs: 20,
		graceMs: 60,
		agentSignal: Promise.resolve<"finished">("finished"),
	});
	assert.equal(outcome, "finished");
});

test("waitForRunCompletion prefers 'stable' when a final write lands during the grace window", async () => {
	const path = tmpFile();
	// Signal 'finished' promptly, but write the file shortly after so the grace
	// window observes a stable file and upgrades the outcome to 'stable'.
	const agentSignal = new Promise<"finished">((resolve) => {
		setTimeout(() => {
			writeFileSync(path, "late but complete");
			resolve("finished");
		}, 80);
	});
	const outcome = await waitForRunCompletion(path, {
		timeoutMs: 5000,
		intervalMs: 20,
		graceMs: 2000,
		agentSignal,
	});
	assert.equal(outcome, "stable");
});

test("waitForRunCompletion times out when nothing ever happens", async () => {
	const path = tmpFile();
	const outcome: RunOutcome = await waitForRunCompletion(path, { timeoutMs: 120, intervalMs: 20 });
	assert.equal(outcome, "timeout");
});

test("readLastAssistantText returns the last assistant message from the transcript", () => {
	const path = tmpFile();
	writeFileSync(
		path,
		[
			sessionLine("user", [{ type: "text", text: "review the diff" }]),
			sessionLine("assistant", [{ type: "thinking", thinking: "looking" }, { type: "text", text: "first pass" }]),
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
	const r = await resolveRunOutput({
		outputPath: out,
		sessionPath: session,
		fallback: () => {
			fallbackCalls++;
			return "unused";
		},
		finishedCleanly: true,
	});
	assert.deepEqual(r, { output: "from transcript", ok: true });
	assert.equal(fallbackCalls, 0); // fallback skipped when the transcript wins
	// The resolved result is persisted to the run-dir artifact for inspection.
	assert.equal(readFileSync(out, "utf-8"), "from transcript");
});

test("resolveRunOutput awaits the async fallback only when the transcript misses", async () => {
	const out = tmpFile();
	const r = await resolveRunOutput({
		outputPath: out,
		sessionPath: tmpFile(), // never created
		fallback: () => Promise.resolve("from pane"),
		finishedCleanly: true,
	});
	assert.deepEqual(r, { output: "from pane", ok: true });
	assert.equal(readFileSync(out, "utf-8"), "from pane");
});

test("resolveRunOutput is not ok when the run did not finish cleanly, even with output", async () => {
	const session = tmpFile();
	writeFileSync(session, sessionLine("assistant", [{ type: "text", text: "got text but crashed" }]));
	const r = await resolveRunOutput({
		outputPath: tmpFile(),
		sessionPath: session,
		fallback: () => undefined,
		finishedCleanly: false,
	});
	assert.equal(r.ok, false);
	assert.equal(r.output, "got text but crashed");
});

test("resolveRunOutput uses the placeholder and is not ok when no source yields text", async () => {
	const r = await resolveRunOutput({
		outputPath: tmpFile(),
		sessionPath: tmpFile(),
		fallback: () => undefined,
		finishedCleanly: true,
		placeholder: "(nothing)",
	});
	assert.deepEqual(r, { output: "(nothing)", ok: false });
});
