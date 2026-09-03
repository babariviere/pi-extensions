import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	appendCapability,
	capabilityJournalPathFor,
	formatCapabilities,
	latestCapabilities,
	readCapabilityJournal,
} from "./capability-journal.ts";

const journal = (): string => join(mkdtempSync(join(tmpdir(), "night-capability-")), "capability-journal.jsonl");

test("the journal lives beside the per-subagent workspaces, where children can read it", () => {
	assert.equal(
		capabilityJournalPathFor({ workspacePath: "/sandboxes/phishing/2026-09-02 2048", reportPath: "/notes/r.md" }),
		"/sandboxes/phishing/2026-09-02 2048.agents/capability-journal.jsonl",
	);
	assert.equal(capabilityJournalPathFor({ reportPath: "/notes/r.md" }), "/notes/capability-journal.jsonl");
});

test("findings append and read back in order", () => {
	const path = journal();
	assert.equal(appendCapability(path, { at: 1, capability: "subagent-launch", state: "working" }), true);
	appendCapability(path, { at: 2, capability: "loopback-tcp", state: "broken", detail: "operation not permitted" });
	const entries = readCapabilityJournal(path);
	assert.deepEqual(
		entries.map((entry) => entry.capability),
		["subagent-launch", "loopback-tcp"],
	);
});

test("the last word per capability wins, so a recovery is visible", () => {
	const path = journal();
	appendCapability(path, { at: 1, capability: "subagent-launch", state: "broken", detail: "startup timeout" });
	appendCapability(path, { at: 2, capability: "subagent-launch", state: "working" });
	const latest = latestCapabilities(readCapabilityJournal(path));
	assert.equal(latest.length, 1);
	assert.equal(latest[0].state, "working");
});

test("a half-written line does not lose the journal", () => {
	const path = journal();
	appendCapability(path, { at: 1, capability: "push", state: "working" });
	appendCapability(path, { at: 2, capability: "push", state: "broken" });
	// Simulate a crash mid-append.
	appendCapability(path, { at: 3, capability: "x", state: "broken" });
	const entries = readCapabilityJournal(path);
	assert.equal(entries.length, 3);
});

test("a missing journal reads as empty rather than throwing", () => {
	assert.deepEqual(readCapabilityJournal(join(tmpdir(), "no-such-journal.jsonl")), []);
	assert.equal(formatCapabilities([]), "Nothing recorded yet.");
});

test("formatCapabilities leads with the verdict", () => {
	const text = formatCapabilities([
		{ at: 0, capability: "subagent-launch", state: "broken", detail: "timed out waiting for agent startup" },
	]);
	assert.match(text, /^- subagent-launch: broken - timed out waiting for agent startup \(1970-/);
});
