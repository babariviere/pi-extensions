import assert from "node:assert/strict";
import { test } from "node:test";

import { type KillableChild, signalProcessTree, terminateProcessTree } from "./process-tree.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface FakeChild extends KillableChild {
	direct: NodeJS.Signals[];
	close(): void;
}

const fakeChild = (pid: number | undefined): FakeChild => {
	const listeners: Array<() => void> = [];
	return {
		pid,
		direct: [],
		kill(signal) {
			this.direct.push(signal ?? "SIGTERM");
			return true;
		},
		once(_event, listener) {
			listeners.push(listener);
			return this;
		},
		close() {
			for (const listener of listeners.splice(0)) listener();
		},
	};
};

test("a signal addresses the child's whole process group", () => {
	const child = fakeChild(99);
	const sent: Array<[number, NodeJS.Signals]> = [];
	signalProcessTree(child, "SIGTERM", { kill: (pid, signal) => void sent.push([pid, signal]) });
	assert.deepEqual(sent, [[-99, "SIGTERM"]]);
	assert.deepEqual(child.direct, []);
});

test("a child with no process group still gets signalled directly", () => {
	const child = fakeChild(99);
	signalProcessTree(child, "SIGKILL", {
		kill: () => {
			throw new Error("ESRCH");
		},
	});
	assert.deepEqual(child.direct, ["SIGKILL"]);
});

test("a child that never spawned is not signalled", () => {
	const child = fakeChild(undefined);
	let calls = 0;
	signalProcessTree(child, "SIGTERM", { kill: () => void calls++ });
	assert.equal(calls, 0);
	assert.deepEqual(child.direct, []);
});

test("teardown escalates from SIGTERM to SIGKILL after the grace period", async () => {
	const child = fakeChild(7);
	const sent: NodeJS.Signals[] = [];
	terminateProcessTree(child, { graceMs: 10, deps: { kill: (_pid, signal) => void sent.push(signal) } });
	assert.deepEqual(sent, ["SIGTERM"]);
	await sleep(40);
	assert.deepEqual(sent, ["SIGTERM", "SIGKILL"]);
});

test("a child that exits in time is never SIGKILLed", async () => {
	const child = fakeChild(7);
	const sent: NodeJS.Signals[] = [];
	terminateProcessTree(child, { graceMs: 20, deps: { kill: (_pid, signal) => void sent.push(signal) } });
	child.close();
	await sleep(50);
	assert.deepEqual(sent, ["SIGTERM"]);
});
