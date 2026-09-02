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

test("startAgent retries while the pane is busy, then succeeds", async () => {
	const { transport, calls } = scriptedTransport((_, call) =>
		call < 2 ? { ok: false, error: "agent target pane wA:p1 is not an available shell" } : { ok: true, result: {} },
	);
	const res = await new HerdrClient(transport).startAgent("sub-0-abc", "pi", "wA:p1", ["--flag"], 60000, {
		pollMs: 1,
		readyTimeoutMs: 5000,
	});
	assert.equal(res.ok, true);
	assert.equal(calls.length, 3);
});

test("startAgent times out with a clear error when the pane stays busy", async () => {
	const { transport } = scriptedTransport([{ ok: false, error: "agent target pane wA:p1 is not an available shell" }]);
	const res = await new HerdrClient(transport).startAgent("sub-0-abc", "pi", "wA:p1", ["--flag"], 60000, {
		pollMs: 1,
		readyTimeoutMs: 30,
	});
	assert.equal(res.ok, false);
	assert.match(res.error ?? "", /wA:p1 did not become ready/);
	assert.match(res.error ?? "", /within 30ms/);
	assert.match(res.error ?? "", /not an available shell/);
});

test("startAgent fails fast on a non-busy error without retrying", async () => {
	const { transport, calls } = scriptedTransport([{ ok: false, error: "unsupported interactive agent kind foo" }]);
	const res = await new HerdrClient(transport).startAgent("sub-0-abc", "foo", "wA:p1", ["--flag"], 60000, {
		pollMs: 1,
		readyTimeoutMs: 5000,
	});
	assert.equal(res.ok, false);
	assert.match(res.error ?? "", /unsupported interactive agent kind/);
	assert.equal(calls.length, 1);
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

test("promptAgent confirms the submission started a turn", async () => {
	const { transport, calls } = scriptedTransport([{ ok: true, result: {} }]);
	const res = await new HerdrClient(transport).promptAgent("wA:p1", "do the thing", { waitMs: 1234 });
	assert.equal(res.ok, true);
	assert.deepEqual(calls[0], [
		"agent",
		"prompt",
		"wA:p1",
		"do the thing",
		"--wait",
		"--until",
		"working",
		"--until",
		"done",
		"--timeout",
		"1234",
	]);
});

test("promptAgent replays the submit key when herdr reports a stalled prompt", async () => {
	// The task text is already in the composer, so the repair is Enter alone —
	// never a second `agent prompt`, which would duplicate the text.
	const { transport, calls } = scriptedTransport((args) => {
		if (args[1] === "prompt") return { ok: false, error: "agent_prompt_stalled" };
		if (args[1] === "get" || args[0] === "pane") return { ok: true, result: { agent_status: "idle" } };
		if (args[1] === "send-keys") return { ok: true, result: {} };
		return { ok: true, stdout: '{"agent_status":"working"}' };
	});
	const res = await new HerdrClient(transport).promptAgent("wA:p1", "do the thing", { waitMs: 50 });
	assert.equal(res.ok, true);
	assert.deepEqual(
		calls.map((c) => c.slice(0, 2).join(" ")),
		["agent prompt", "pane get", "agent send-keys", "agent wait"],
	);
	assert.deepEqual(calls[2], ["agent", "send-keys", "wA:p1", "Enter"]);
});

test("promptAgent gives up with a clear error when the agent never starts working", async () => {
	const { transport, calls } = scriptedTransport((args) => {
		if (args[1] === "prompt") return { ok: false, error: "agent_prompt_stalled" };
		if (args[0] === "pane") return { ok: true, result: { agent_status: "idle" } };
		if (args[1] === "send-keys") return { ok: true, result: {} };
		return { ok: false, error: "wait timed out" };
	});
	const res = await new HerdrClient(transport).promptAgent("wA:p1", "task", { waitMs: 10, retries: 2 });
	assert.equal(res.ok, false);
	assert.match(res.error ?? "", /no turn started after 2 submit retries/);
	assert.equal(calls.filter((c) => c[1] === "send-keys").length, 2);
});

test("promptAgent fails fast on a blocked agent without sending keys", async () => {
	const { transport, calls } = scriptedTransport([{ ok: false, error: "agent_blocked" }]);
	const res = await new HerdrClient(transport).promptAgent("wA:p1", "task", { waitMs: 10 });
	assert.equal(res.ok, false);
	assert.match(res.error ?? "", /agent_blocked/);
	assert.equal(calls.length, 1);
});

test("promptAgent treats a --wait timeout as delivered, not stalled", async () => {
	// herdr only starts the settled-state wait after an observed state change, so
	// a timeout means the input was accepted (the turn may even be over already).
	const { transport, calls } = scriptedTransport([{ ok: false, error: "wait timed out" }]);
	const res = await new HerdrClient(transport).promptAgent("wA:p1", "task", { waitMs: 10 });
	assert.equal(res.ok, true);
	assert.equal(calls.length, 1);
});
