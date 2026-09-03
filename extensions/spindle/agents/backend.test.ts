import assert from "node:assert/strict";
import { test } from "node:test";
import { probeHerdrDialect, RunLauncher, type BackendSelection } from "./backend.ts";
import type { HerdrCliResult } from "./herdr-parse.ts";
import type { HerdrTransport } from "./herdr-transport.ts";
import type { RunBackend, RunContext, RunRequest, RunResult } from "./run.ts";

/**
 * The launcher and the dialect probe, tested through their interfaces with an
 * in-memory transport and fake backends: no `herdr` binary and no child `pi`
 * processes are involved.
 */

function scriptedTransport(result: (args: string[]) => HerdrCliResult): {
	transport: HerdrTransport;
	calls: string[][];
} {
	const calls: string[][] = [];
	return {
		calls,
		transport: {
			run: (args) => {
				calls.push(args);
				return Promise.resolve(result(args));
			},
		},
	};
}

const START_HELP: HerdrCliResult = {
	ok: true,
	result: {},
	stdout: "Usage: herdr agent start <name> [--kind <kind>] [--pane <id>]",
};
const AGENT_HELP: HerdrCliResult = {
	ok: true,
	result: {},
	stdout: "Commands: start, prompt, wait",
};

test("probe accepts the dialect the adapter speaks", async () => {
	const { transport, calls } = scriptedTransport((args) => (args.includes("start") ? START_HELP : AGENT_HELP));
	const verdict = await probeHerdrDialect(transport);
	assert.equal(verdict.compatible, true);
	assert.equal(calls.length, 2);
});

test("probe rejects a CLI whose agent start lacks --kind (the observed drift)", async () => {
	const { transport } = scriptedTransport((args) =>
		args.includes("start")
			? { ok: true, result: {}, stdout: "Usage: herdr agent start <name> [--pane <id>]" }
			: AGENT_HELP,
	);
	const verdict = await probeHerdrDialect(transport);
	assert.equal(verdict.compatible, false);
	assert.match(verdict.reason ?? "", /--kind/);
});

test("probe rejects a CLI without agent wait", async () => {
	const { transport } = scriptedTransport((args) =>
		args.includes("start") ? START_HELP : { ok: true, result: {}, stdout: "Commands: start, prompt" },
	);
	const verdict = await probeHerdrDialect(transport);
	assert.equal(verdict.compatible, false);
	assert.match(verdict.reason ?? "", /wait/);
});

test("probe rejects a CLI that cannot even show help", async () => {
	const { transport } = scriptedTransport(() => ({ ok: false, error: "unknown option: --kind" }));
	const verdict = await probeHerdrDialect(transport);
	assert.equal(verdict.compatible, false);
	assert.match(verdict.reason ?? "", /unavailable/);
});

/** A minimal request; the fake backends only read the agent name off it. */
const runRequest = (): RunRequest => ({
	agent: { scope: "user", config: { name: "task", body: "" } } as unknown as RunRequest["agent"],
	task: "do a thing",
	index: 0,
});

const emptyContext = (): RunContext => ({
	sessionId: undefined,
	sessionFile: undefined,
	runId: "test-run",
	cwd: process.cwd(),
	timeoutMs: 1000,
});

test("outside herdr the launcher picks headless and never probes", async () => {
	const used: string[] = [];
	let probes = 0;
	const launcher = new RunLauncher({
		inHerdr: () => false,
		probe: () => {
			probes++;
			return Promise.resolve({ compatible: true });
		},
		herdr: (async () => {
			used.push("herdr");
			return [];
		}) as RunBackend,
		headless: (async () => {
			used.push("headless");
			return [];
		}) as RunBackend,
	});
	const selection = await launcher.selection();
	assert.deepEqual(selection, { backend: "headless" } satisfies BackendSelection);
	await launcher.run([], emptyContext());
	assert.deepEqual(used, ["headless"]);
	assert.equal(probes, 0);
});

test("a compatible herdr dialect selects the herdr adapter", async () => {
	const used: string[] = [];
	const launcher = new RunLauncher({
		inHerdr: () => true,
		probe: () => Promise.resolve({ compatible: true }),
		herdr: (async () => {
			used.push("herdr");
			return [];
		}) as RunBackend,
		headless: (async () => {
			used.push("headless");
			return [];
		}) as RunBackend,
	});
	const selection = await launcher.selection();
	assert.deepEqual(selection, { backend: "herdr" } satisfies BackendSelection);
	await launcher.run([], emptyContext());
	assert.deepEqual(used, ["herdr"]);
});

test("a drifted herdr falls back to headless and probes only once", async () => {
	const used: string[] = [];
	let probes = 0;
	const launcher = new RunLauncher({
		inHerdr: () => true,
		probe: () => {
			probes++;
			return Promise.resolve({ compatible: false, reason: "herdr agent start does not accept --kind" });
		},
		herdr: (async () => {
			used.push("herdr");
			return [];
		}) as RunBackend,
		headless: (async () => {
			used.push("headless");
			return [];
		}) as RunBackend,
	});
	const selection = await launcher.selection();
	assert.equal(selection.backend, "headless");
	assert.match(selection.degradedReason ?? "", /--kind/);
	await launcher.run([], emptyContext());
	await launcher.run([], emptyContext());
	assert.deepEqual(used, ["headless", "headless"]);
	assert.equal(probes, 1);
});

test("a herdr that stops launching children is demoted to headless mid-session", async () => {
	const used: string[] = [];
	const launchFailure = (agent: string): RunResult => ({
		agent,
		scope: "user",
		ok: false,
		output: "(failed to run in herdr: timed out waiting for agent startup)",
		backend: "herdr",
		error: "timed out waiting for agent startup",
		failure: "launch",
	});
	const launcher = new RunLauncher({
		inHerdr: () => true,
		probe: () => Promise.resolve({ compatible: true }),
		herdr: async (reqs) => {
			used.push("herdr");
			return reqs.map((req) => launchFailure(req.agent.config.name));
		},
		headless: async (reqs) => {
			used.push("headless");
			return reqs.map((req) => ({
				agent: req.agent.config.name,
				scope: "user",
				ok: true,
				output: "done",
				backend: "headless" as const,
			}));
		},
	});

	for (let i = 0; i < 3; i++) await launcher.run([runRequest()], emptyContext());

	// Two launch failures are enough; the third batch goes elsewhere.
	assert.deepEqual(used, ["herdr", "herdr", "headless"]);
	const selection = await launcher.selection();
	assert.equal(selection.backend, "headless");
	assert.match(selection.degradedReason ?? "", /failed to launch 2 children in a row/);
	assert.match(selection.degradedReason ?? "", /waiting for agent startup/);
});

test("a run that actually ran clears the launch-failure streak", async () => {
	const used: string[] = [];
	let call = 0;
	const launcher = new RunLauncher({
		inHerdr: () => true,
		probe: () => Promise.resolve({ compatible: true }),
		herdr: async (reqs) => {
			used.push("herdr");
			call++;
			// fail, ran-but-empty, fail, fail
			const failure = call === 2 ? ("run" as const) : ("launch" as const);
			return reqs.map((req) => ({
				agent: req.agent.config.name,
				scope: "user",
				ok: false,
				output: "",
				backend: "herdr" as const,
				failure,
			}));
		},
		headless: async () => {
			used.push("headless");
			return [];
		},
	});

	for (let i = 0; i < 4; i++) await launcher.run([runRequest()], emptyContext());

	// The `run` failure in the middle resets the count, so the demotion only
	// lands after the two that follow it.
	assert.deepEqual(used, ["herdr", "herdr", "herdr", "herdr"]);
	assert.equal((await launcher.selection()).backend, "headless");
});
