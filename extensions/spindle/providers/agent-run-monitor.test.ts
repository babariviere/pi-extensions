import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunRequest } from "../agents/run.ts";
import type { SpindleInvocationContext } from "../protocol.ts";
import { RunProgressMonitor, SpindleAgentRunRegistry } from "./agent-run-monitor.ts";

const req = (name: string, index: number): RunRequest =>
	({ agent: { config: { name }, scope: "user" }, task: "t", index }) as unknown as RunRequest;

function fixture() {
	const registry = new SpindleAgentRunRegistry();
	const updates: string[] = [];
	const context = {
		parentToolCallId: "call-1",
		update: (message: string) => updates.push(message),
		activity: () => {},
	} as unknown as SpindleInvocationContext;
	const monitor = new RunProgressMonitor({ registry, context, runId: "run-1" }, [
		req("worker", 0),
		req("reviewer", 1),
	]);
	return { registry, updates, monitor };
}

const byName = (registry: SpindleAgentRunRegistry, name: string) =>
	registry.list().find((run) => run.name === name);

test("start seeds one queued registry row per request, tagged with the parent tool call", () => {
	const { registry, monitor, updates } = fixture();
	monitor.start();
	try {
		const rows = registry.list();
		assert.equal(rows.length, 2);
		assert.equal(byName(registry, "worker")?.status, "queued");
		assert.equal(byName(registry, "worker")?.id, "run-1-0");
		assert.equal(byName(registry, "reviewer")?.id, "run-1-1");
		assert.equal(byName(registry, "worker")?.runId, "call-1");
		assert.ok(updates.length >= 1); // start published one ticker frame
	} finally {
		monitor.stop();
	}
});

test("onStatus mirrors backend transitions into the registry, mapping run state to status", () => {
	const { registry, monitor } = fixture();
	monitor.start();
	try {
		monitor.onStatus(0, { state: "running" });
		assert.equal(byName(registry, "worker")?.status, "running");
		assert.equal(byName(registry, "worker")?.currentTool, "running");
		monitor.onStatus(0, { state: "done" });
		monitor.onStatus(1, { state: "failed" });
		assert.equal(byName(registry, "worker")?.status, "completed");
		assert.equal(byName(registry, "reviewer")?.status, "failed");
		// terminal rows carry no currentTool
		assert.equal(byName(registry, "worker")?.currentTool, undefined);
	} finally {
		monitor.stop();
	}
});

test("stop publishes a final registry frame and stops the ticker", () => {
	const { registry, updates, monitor } = fixture();
	monitor.start();
	monitor.onStatus(0, { state: "done" });
	monitor.onStatus(1, { state: "done" });
	const before = updates.length;
	monitor.stop();
	// stop's final publish is registry-only (live=false), so no new ticker text
	assert.equal(updates.length, before);
	assert.equal(byName(registry, "worker")?.status, "completed");
});
