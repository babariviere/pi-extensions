import assert from "node:assert/strict";
import { test } from "node:test";

import { SpindleActivityStore } from "./activity/store.ts";
import { HOST_CALLS, type HostCallContext } from "./host-calls.ts";

const RUN_ID = "test-call";

const handlerFor = (ref: string) => {
	const entry = HOST_CALLS.find((call) => call.ref === ref);
	assert.ok(entry, `no host call registered for ${ref}`);
	return entry.handle;
};

/** A host-call context with a real activity store and inert everything else. */
const contextWith = (store: SpindleActivityStore) => {
	store.start(RUN_ID, { name: "program" });
	const updates: string[] = [];
	const context = {
		activity: store,
		parentToolCallId: RUN_ID,
		phases: [] as string[],
		workflowSpans: new Map(),
		issueCall: () => ({ succeed: () => {}, fail: () => {} }),
		update: (message: string) => updates.push(message),
		traceAttempt: async (
			_ref: string,
			_args: Record<string, unknown>,
			_signal: AbortSignal,
			run: (setStage: () => void) => unknown,
		) => run(() => {}),
	} as unknown as HostCallContext;
	return { context, updates };
};

const startSpan = async (context: HostCallContext, id: string, itemCount: number) =>
	handlerFor("spindle.$spanStart")({ id, kind: "parallel", itemCount }, context, undefined as never);

const sendItems = async (context: HostCallContext, items: Array<Record<string, unknown>>) =>
	handlerFor("spindle.$items")({ items }, context, undefined as never);

test("a top-level fan-out span opens the phase the widget renders from", async () => {
	const store = new SpindleActivityStore();
	const { context, updates } = contextWith(store);
	await startSpan(context, "span-0", 40);

	const run = store.get(RUN_ID);
	assert.equal(run?.phases.length, 1);
	assert.equal(run?.phases[0]!.name, "fan-out \u00d740");
	assert.equal(run?.phases[0]!.total, 40);
	// ui/widget.ts renders phase progress only when currentPhaseId is set.
	assert.equal(run?.currentPhaseId, run?.phases[0]!.id);
	// The inline chips in spindle-exec-tool.ts read this array.
	assert.deepEqual(context.phases, ["fan-out \u00d740"]);
	assert.deepEqual(updates, ["fan-out \u00d740"]);
});

test("inferred items attach to the fan-out phase, so progress is countable", async () => {
	const store = new SpindleActivityStore();
	const { context } = contextWith(store);
	await startSpan(context, "span-0", 4);
	await sendItems(context, [
		{ id: "span-0-0", label: "a.ts", status: "completed", total: 4 },
		{ id: "span-0-1", label: "b.ts", status: "completed", total: 4 },
		{ id: "span-0-2", label: "c.ts", status: "running", total: 4 },
	]);

	const run = store.get(RUN_ID)!;
	const phaseId = run.currentPhaseId;
	assert.ok(phaseId);
	assert.equal(run.items.length, 3);
	// Every item inherited the phase without anything passing `phase` through.
	assert.deepEqual(new Set(run.items.map((item) => item.phaseId)), new Set([phaseId]));
	// This is exactly what ui/widget.ts phaseProgress() computes.
	const statuses = run.items.filter((item) => item.phaseId === phaseId).map((item) => item.status);
	assert.equal(statuses.filter((status) => status === "completed").length, 2);
});

test("a nested span does not steal the outer fan-out's phase", async () => {
	const store = new SpindleActivityStore();
	const { context } = contextWith(store);
	await startSpan(context, "span-outer", 10);
	const outer = store.get(RUN_ID)!.currentPhaseId;
	await startSpan(context, "span-inner", 5);

	const run = store.get(RUN_ID)!;
	assert.equal(run.phases.length, 1);
	assert.equal(run.currentPhaseId, outer);
	assert.deepEqual(context.phases, ["fan-out \u00d710"]);
});

test("consecutive fan-outs become distinct phases and close the previous one", async () => {
	const store = new SpindleActivityStore();
	const { context } = contextWith(store);
	await startSpan(context, "span-0", 4);
	context.workflowSpans.clear();
	await startSpan(context, "span-1", 4);

	const run = store.get(RUN_ID)!;
	assert.equal(run.phases.length, 2);
	// store.phase() completes the previous phase when a new one opens.
	assert.equal(run.phases[0]!.status, "completed");
	assert.equal(run.phases[1]!.status, "running");
	assert.equal(run.currentPhaseId, run.phases[1]!.id);
	assert.deepEqual(context.phases, ["fan-out \u00d74", "fan-out \u00d74"]);
});

test("a span with no item count still names a phase", async () => {
	const store = new SpindleActivityStore();
	const { context } = contextWith(store);
	await handlerFor("spindle.$spanStart")({ id: "span-0", kind: "parallel" }, context, undefined as never);

	const run = store.get(RUN_ID)!;
	assert.equal(run.phases[0]!.name, "fan-out");
	assert.equal(run.phases[0]!.total, undefined);
});
