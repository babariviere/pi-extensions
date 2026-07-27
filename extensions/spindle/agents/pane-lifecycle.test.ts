import assert from "node:assert/strict";
import { test } from "node:test";
import { type AgentWaitResult, type PaneAgentState } from "./herdr.ts";
import { type StatusProbe, waitForAgentFinish } from "./pane-lifecycle.ts";

/**
 * Scripted fake probe: `waits` are returned in order for successive
 * `waitUntil` calls; `peeks` for successive `peek` calls. Records how many of
 * each were consumed so tests can assert the machine stopped early.
 */
function fakeProbe(script: { waits: AgentWaitResult[]; peeks?: PaneAgentState[] }): StatusProbe & { waitCalls: number; peekCalls: number } {
	let waitCalls = 0;
	let peekCalls = 0;
	const probe = {
		get waitCalls() {
			return waitCalls;
		},
		get peekCalls() {
			return peekCalls;
		},
		async waitUntil(): Promise<AgentWaitResult> {
			const next = script.waits[waitCalls] ?? { kind: "timeout" as const };
			waitCalls++;
			return next;
		},
		async peek(): Promise<PaneAgentState> {
			const next = script.peeks?.[peekCalls] ?? { exists: true };
			peekCalls++;
			return next;
		},
	};
	return probe;
}

test("waitForAgentFinish finishes when working then idle are reached", async () => {
	const probe = fakeProbe({
		waits: [
			{ kind: "reached", status: "working" },
			{ kind: "reached", status: "idle" },
		],
	});
	assert.equal(await waitForAgentFinish(probe, 5000), "finished");
	assert.equal(probe.waitCalls, 2);
	assert.equal(probe.peekCalls, 0); // no re-checks needed
});

test("waitForAgentFinish treats a fast background 'done' in phase 1 as finished", async () => {
	const probe = fakeProbe({ waits: [{ kind: "reached", status: "done" }] });
	assert.equal(await waitForAgentFinish(probe, 5000), "finished");
	assert.equal(probe.waitCalls, 1);
});

test("waitForAgentFinish reports gone when phase 1 wait reports a closed pane", async () => {
	const probe = fakeProbe({ waits: [{ kind: "gone" }] });
	assert.equal(await waitForAgentFinish(probe, 5000), "gone");
});

test("waitForAgentFinish reports gone when the pane vanishes between phase-2 chunks", async () => {
	const probe = fakeProbe({
		waits: [
			{ kind: "reached", status: "working" },
			{ kind: "timeout" }, // phase-2 chunk elapsed; re-check existence
		],
		peeks: [{ exists: false }],
	});
	assert.equal(await waitForAgentFinish(probe, 5000), "gone");
});

test("waitForAgentFinish keeps waiting through a startup 'not_running' then finishes", async () => {
	const probe = fakeProbe({
		waits: [
			{ kind: "not_running" }, // still starting up
			{ kind: "reached", status: "working" },
			{ kind: "reached", status: "done" },
		],
		peeks: [{ exists: true, status: "unknown" }], // re-check after the not_running chunk
	});
	assert.equal(await waitForAgentFinish(probe, 5000), "finished");
	assert.equal(probe.waitCalls, 3);
});

test("waitForAgentFinish fast-finishes when a between-chunk peek finds the pane already idle", async () => {
	const probe = fakeProbe({
		waits: [{ kind: "timeout" }], // phase-1 chunk elapsed without reaching working
		peeks: [{ exists: true, status: "idle" }],
	});
	assert.equal(await waitForAgentFinish(probe, 5000), "finished");
	assert.equal(probe.waitCalls, 1);
	assert.equal(probe.peekCalls, 1);
});
