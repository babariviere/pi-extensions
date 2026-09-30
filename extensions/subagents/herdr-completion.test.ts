import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type RunOutcome, waitForRunCompletion } from "./herdr-completion.ts";

function tmpFile(): string {
	return join(mkdtempSync(join(tmpdir(), "herdr-completion-test-")), "out.md");
}

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

test("waitForRunCompletion ignores a stable file while an agent signal is still pending", async () => {
	// The herdr backend watches the child transcript, which pauses mid-turn. A
	// pause (stable file) must not be mistaken for completion; only the agent
	// signal (idle/gone) finishes the run.
	const path = tmpFile();
	writeFileSync(path, "looks stable but the agent is still working");
	const neverIdle = new Promise<"finished">(() => {});
	const outcome = await waitForRunCompletion(path, {
		timeoutMs: 120,
		intervalMs: 20,
		agentSignal: neverIdle,
	});
	assert.equal(outcome, "timeout");
});

test("waitForRunCompletion times out with no agent signal (the degenerate case)", async () => {
	const path = tmpFile();
	const outcome: RunOutcome = await waitForRunCompletion(path, { timeoutMs: 120, intervalMs: 20 });
	assert.equal(outcome, "timeout");
});

test("waitForRunCompletion re-arms the agent wait when idle lands mid-turn", async () => {
	// The pane looked idle between a tool result and the next model stream. The
	// run must NOT finalize there: the caller would tear the pane down and kill a
	// child that was still generating.
	const path = tmpFile();
	writeFileSync(path, "transcript ending on a toolResult");
	let turnComplete = false;
	let arms = 0;
	const outcome = await waitForRunCompletion(path, {
		timeoutMs: 5000,
		intervalMs: 10,
		graceMs: 30,
		agentSignal: Promise.resolve<"finished">("finished"),
		rearmAgentSignal: () => {
			arms++;
			// The real turn ends during the second wait.
			if (arms >= 2) {
				writeFileSync(path, "transcript ending on a final assistant message");
				turnComplete = true;
			}
			return Promise.resolve<"finished">("finished");
		},
		isTurnComplete: () => turnComplete,
	});
	assert.equal(outcome, "stable");
	assert.ok(arms >= 2, `expected the wait to be re-armed, got ${arms}`);
});

test("waitForRunCompletion times out rather than finalizing an endless false idle", async () => {
	const path = tmpFile();
	writeFileSync(path, "stuck mid-turn");
	const outcome = await waitForRunCompletion(path, {
		timeoutMs: 150,
		intervalMs: 10,
		graceMs: 20,
		agentSignal: Promise.resolve<"finished">("finished"),
		rearmAgentSignal: () => Promise.resolve<"finished">("finished"),
		isTurnComplete: () => false,
	});
	assert.equal(outcome, "timeout");
});

test("waitForRunCompletion extends the flush grace while the transcript keeps growing", async () => {
	const path = tmpFile();
	writeFileSync(path, "start");
	let text = "start";
	// Grow the file for longer than one grace window, then stop.
	const growth = setInterval(() => {
		text += "more";
		writeFileSync(path, text);
	}, 10);
	setTimeout(() => clearInterval(growth), 120);
	const outcome = await waitForRunCompletion(path, {
		timeoutMs: 5000,
		intervalMs: 10,
		graceMs: 40,
		agentSignal: Promise.resolve<"finished">("finished"),
		isTurnComplete: () => true,
	});
	clearInterval(growth);
	assert.equal(outcome, "stable");
});

test("waitForRunCompletion still reports 'finished' with no re-arm available", async () => {
	const path = tmpFile();
	writeFileSync(path, "mid-turn");
	const outcome = await waitForRunCompletion(path, {
		timeoutMs: 5000,
		intervalMs: 10,
		graceMs: 30,
		agentSignal: Promise.resolve<"finished">("finished"),
		isTurnComplete: () => false,
	});
	assert.equal(outcome, "finished");
});
