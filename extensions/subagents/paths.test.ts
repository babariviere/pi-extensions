import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { cleanupOldRuns, runPaths, runRootDir, runsBaseDir } from "./paths.ts";

function tmpRoot(): string {
	return mkdtempSync(join(tmpdir(), "paths-test-"));
}

test("runsBaseDir anchors next to the session file when present", () => {
	const sessionFile = "/home/u/.pi/agent/sessions/proj/2026-01-01_abc.jsonl";
	assert.equal(runsBaseDir(sessionFile), join(dirname(sessionFile), "subagent-runs"));
});

test("runsBaseDir falls back to a temp dir with no session file", () => {
	assert.equal(runsBaseDir(undefined), join(tmpdir(), "pi-subagents"));
});

test("runPaths nests runId under the sanitized session id", () => {
	const sessionFile = "/s/dir/sess.jsonl";
	const p = runPaths(sessionFile, "sess:id", "run-1", "my agent", 2);
	assert.equal(p.dir, join(runRootDir(sessionFile, "sess:id"), "run-1"));
	assert.equal(p.outputPath, join(p.dir, "my_agent-2.md"));
	assert.equal(p.sessionPath, join(p.dir, "my_agent-2.session.jsonl"));
});

test("cleanupOldRuns prunes stale run dirs and keeps fresh ones", () => {
	const root = tmpRoot();
	const sessionFile = join(root, "sess.jsonl");
	const base = runsBaseDir(sessionFile);

	const oldRun = join(base, "session-a", "old-run");
	const freshRun = join(base, "session-a", "fresh-run");
	mkdirSync(oldRun, { recursive: true });
	mkdirSync(freshRun, { recursive: true });

	const old = Date.now() / 1000 - 60 * 24 * 60 * 60; // 60 days ago (seconds)
	utimesSync(oldRun, old, old);

	cleanupOldRuns(sessionFile, 14);

	assert.equal(existsSync(oldRun), false);
	assert.equal(existsSync(freshRun), true);
	// Marker written so the next sweep is throttled.
	assert.equal(existsSync(join(base, ".last-cleanup")), true);
});

test("cleanupOldRuns removes an emptied session dir", () => {
	const root = tmpRoot();
	const sessionFile = join(root, "sess.jsonl");
	const base = runsBaseDir(sessionFile);
	const sessionDir = join(base, "session-b");
	const staleRun = join(sessionDir, "run");
	mkdirSync(staleRun, { recursive: true });
	const old = Date.now() / 1000 - 60 * 24 * 60 * 60;
	utimesSync(staleRun, old, old);

	cleanupOldRuns(sessionFile, 14);

	assert.equal(existsSync(sessionDir), false);
});

test("cleanupOldRuns is throttled by a recent marker", () => {
	const root = tmpRoot();
	const sessionFile = join(root, "sess.jsonl");
	const base = runsBaseDir(sessionFile);
	const staleRun = join(base, "session-c", "run");
	mkdirSync(staleRun, { recursive: true });
	const old = Date.now() / 1000 - 60 * 24 * 60 * 60;
	utimesSync(staleRun, old, old);

	// First sweep prunes and writes the marker.
	cleanupOldRuns(sessionFile, 14);
	assert.equal(existsSync(staleRun), false);

	// Recreate a stale run; a second immediate sweep must be skipped.
	mkdirSync(staleRun, { recursive: true });
	utimesSync(staleRun, old, old);
	cleanupOldRuns(sessionFile, 14);
	assert.equal(existsSync(staleRun), true);
	assert.ok(statSync(join(base, ".last-cleanup")).isFile());
});
