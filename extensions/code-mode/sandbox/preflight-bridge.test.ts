/**
 * The preflight bridge: who probes, how often, and where the answer lands.
 *
 * No real probe runs: `exec` is injected, so the suite never calls `curl`,
 * `ssh` or `gh`.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { writeActiveNightRun } from "../../night-mode/night-run.ts";
import { resetPreflightState, runNightPreflight } from "./preflight-bridge.ts";

let agentDir: string;
let previousAgentDir: string | undefined;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "preflight-bridge-"));
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	mkdirSync(join(agentDir, "night"), { recursive: true });
	resetPreflightState();
});

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
});

const activeRun = (overrides: Record<string, unknown> = {}) =>
	writeActiveNightRun({
		startedAt: 1_700_000_000_000,
		reportPath: join(agentDir, "report.md"),
		maxPullRequests: 5,
		sessionId: "coordinator",
		preflightPath: join(agentDir, "sandbox-capabilities.md"),
		...overrides,
	});

test("the coordinator probes once and the report is written where the handshake says", async () => {
	activeRun();
	const written: Array<{ path: string; body: string }> = [];
	const wrapped: string[] = [];
	const deps = {
		wrap: async (command: string) => {
			wrapped.push(command);
			return `srt -- ${command}`;
		},
		sessionId: "coordinator",
		cwd: agentDir,
		exec: async (_probe: { id: string }, command: string) => ({ exitCode: 0, output: command }),
		write: (path: string, body: string) => {
			written.push({ path, body });
			return true;
		},
	};
	const path = await runNightPreflight(deps);
	assert.equal(path, join(agentDir, "sandbox-capabilities.md"));
	assert.equal(written.length, 1);
	assert.match(written[0].body, /Night sandbox capability probe/);
	// Every wrapped probe went through the sandbox wrapper, which is the whole
	// point: a host-side probe would report an envelope the children do not have.
	assert.equal(wrapped.length > 0, true);

	// Second call in the same run is a no-op.
	assert.equal(await runNightPreflight(deps), undefined);
	assert.equal(written.length, 1);
});

test("the host-shell loopback probe skips the sandbox wrap", async () => {
	activeRun();
	const wrapped: string[] = [];
	const execCalls: Array<{ id: string; command: string }> = [];
	const deps = {
		wrap: async (command: string) => {
			wrapped.push(command);
			return `srt -- ${command}`;
		},
		sessionId: "coordinator",
		cwd: agentDir,
		exec: async (probe: { id: string }, command: string) => {
			execCalls.push({ id: probe.id, command });
			return { exitCode: 0, output: "" };
		},
		write: () => true,
	};
	await runNightPreflight(deps);
	const sandboxCall = execCalls.find((call) => call.id === "loopback-tcp");
	const hostCall = execCalls.find((call) => call.id === "loopback-tcp-host");
	assert.equal(sandboxCall?.command.startsWith("srt -- "), true, "the sandboxed boundary goes through the wrap");
	assert.equal(hostCall?.command.startsWith("srt -- "), false, "the host boundary runs unwrapped");
	// Both probes share the same raw command text, so the wrap call count is what
	// distinguishes them: only the sandboxed probe should have gone through it.
	assert.equal(wrapped.filter((command) => command === hostCall?.command).length, 1, "only loopback-tcp is wrapped");
});

test("a subagent session does not probe", async () => {
	activeRun();
	const path = await runNightPreflight({
		wrap: async (command: string) => command,
		sessionId: "some-child",
		cwd: agentDir,
		exec: async () => ({ exitCode: 0, output: "" }),
		write: () => true,
	});
	assert.equal(path, undefined);
});

test("no active run means no probe", async () => {
	const path = await runNightPreflight({
		wrap: async (command: string) => command,
		sessionId: "coordinator",
		cwd: agentDir,
		exec: async () => ({ exitCode: 0, output: "" }),
		write: () => true,
	});
	assert.equal(path, undefined);
});

test("a report that cannot be written reports no path", async () => {
	activeRun();
	const path = await runNightPreflight({
		wrap: async (command: string) => command,
		sessionId: "coordinator",
		cwd: agentDir,
		exec: async () => ({ exitCode: 0, output: "" }),
		write: () => false,
	});
	assert.equal(path, undefined);
});
