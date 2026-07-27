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
