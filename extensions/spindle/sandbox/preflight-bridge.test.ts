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
	// Every probe went through the sandbox wrapper, which is the whole point: a
	// host-side probe would report an envelope the children do not have.
	assert.equal(wrapped.length > 0, true);

	// Second call in the same run is a no-op.
	assert.equal(await runNightPreflight(deps), undefined);
	assert.equal(written.length, 1);
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
