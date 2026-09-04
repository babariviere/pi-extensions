import assert from "node:assert/strict";
import { test } from "node:test";
import { HerdrClient } from "./herdr-client.ts";
import type { HerdrCliResult } from "./herdr-parse.ts";
import type { HerdrTransport } from "./herdr-transport.ts";

/**
 * In-memory transport: scripts responses and records each call's args. Replaces
 * the fake-`herdr`-on-PATH hack, so the client's arg building and retry logic
 * are unit-testable without spawning anything.
 */
function scriptedTransport(responses: HerdrCliResult[] | ((args: string[], call: number) => HerdrCliResult)): {
	transport: HerdrTransport;
	calls: string[][];
} {
	const calls: string[][] = [];
	let call = 0;
	const transport: HerdrTransport = {
		run(args: string[]) {
			calls.push(args);
			const res =
				typeof responses === "function" ? responses(args, call) : responses[Math.min(call, responses.length - 1)];
			call++;
			return Promise.resolve(res);
		},
	};
	return { transport, calls };
}

test("runPi atomically submits a quoted Pi command with explicit environment", async () => {
	const { transport, calls } = scriptedTransport([{ ok: true, result: {} }]);
	const result = await new HerdrClient(transport).runPi("wA:p1", ["--model", "openai/gpt", "--value=it's"], {
		PI_USAGE_PACING: "off",
		PI_NIGHT_RUN: "1",
	});
	assert.deepEqual(result, { ok: true });
	assert.deepEqual(calls, [
		[
			"pane",
			"run",
			"wA:p1",
			`PI_USAGE_PACING='off' PI_NIGHT_RUN='1' exec pi '--model' 'openai/gpt' '--value=it'"'"'s'`,
		],
	]);
});

test("runPi surfaces a pane-run failure", async () => {
	const result = await new HerdrClient(scriptedTransport([{ ok: false, error: "pane unavailable" }]).transport).runPi(
		"wA:p1",
		["--flag"],
	);
	assert.deepEqual(result, { ok: false, error: "pane unavailable" });
});

test("splitPane sends the right args and returns the new pane id", async () => {
	const { transport, calls } = scriptedTransport([{ ok: true, result: { pane_id: "wA:p2" } }]);
	const res = await new HerdrClient(transport).splitPane("wA:p1", "right", 0.5, "/repo");
	assert.deepEqual(res, { ok: true, paneId: "wA:p2" });
	assert.deepEqual(calls[0], [
		"pane",
		"split",
		"wA:p1",
		"--direction",
		"right",
		"--ratio",
		"0.5000",
		"--no-focus",
		"--cwd",
		"/repo",
	]);
});

test("waitAgentStatus maps CLI outcomes to typed results", async () => {
	const reached = await new HerdrClient(
		scriptedTransport([{ ok: true, stdout: '{"agent_status":"idle"}' }]).transport,
	).waitAgentStatus("wA:p1", ["idle"], 100);
	assert.deepEqual(reached, { kind: "reached", status: "idle" });

	const timedOut = await new HerdrClient(
		scriptedTransport([{ ok: false, error: "wait timed out" }]).transport,
	).waitAgentStatus("wA:p1", ["idle"], 100);
	assert.deepEqual(timedOut, { kind: "timeout" });

	const notRunning = await new HerdrClient(
		scriptedTransport([{ ok: false, error: "agent_not_running" }]).transport,
	).waitAgentStatus("wA:p1", ["idle"], 100);
	assert.deepEqual(notRunning, { kind: "not_running" });
});

test("statusProbe wires peek to `pane get` for the same pane", async () => {
	const { transport, calls } = scriptedTransport([{ ok: true, result: { agent_status: "working" } }]);
	const probe = new HerdrClient(transport).statusProbe("wA:p9");
	const state = await probe.peek();
	assert.deepEqual(state, { exists: true, status: "working" });
	assert.deepEqual(calls[0], ["pane", "get", "wA:p9"]);
});
