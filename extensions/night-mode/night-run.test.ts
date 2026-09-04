/**
 * The night handshake's environment contract.
 *
 * The assertions that matter here are about what a *child* sees: a previous fix
 * for the same bug set `XDG_CONFIG_HOME` on the coordinator process and was
 * verified by reading it back in that same process, which passed while every
 * subagent shell still failed. So the central test spawns a real shell and
 * reads the variable out of it.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
	activeRunPath,
	applyNightRunEnv,
	buildNightContract,
	type ActiveNightRun,
	nightChildEnv,
	writeActiveNightRun,
} from "./night-run.ts";

const run = (overrides: Partial<ActiveNightRun> = {}): ActiveNightRun => ({
	startedAt: 1_700_000_000_000,
	reportPath: "/vault/report.md",
	maxPullRequests: 5,
	ledgerDir: "/night/todos",
	configHome: "/night/sandboxes/repo/run.agents/xdg",
	...overrides,
});

test("nightChildEnv carries the run's config home, ledger store, and pacing policy", () => {
	const env = nightChildEnv(run({ pacingDisabled: true }), { PATH: "/usr/bin" });
	assert.equal(env.XDG_CONFIG_HOME, "/night/sandboxes/repo/run.agents/xdg");
	assert.equal(env.PI_TODO_PATH, "/night/todos");
	assert.equal(env.PI_NIGHT_RUN, "1");
	assert.equal(env.PI_USAGE_PACING, "off");
	assert.equal(env.PATH, "/usr/bin");
});

test("nightChildEnv overrides a config home inherited from the parent", () => {
	const env = nightChildEnv(run(), { XDG_CONFIG_HOME: "/home/dev/.config" });
	assert.equal(env.XDG_CONFIG_HOME, "/night/sandboxes/repo/run.agents/xdg");
});

test("nightChildEnv leaves the environment alone when no run is active", () => {
	const env = nightChildEnv(undefined, { XDG_CONFIG_HOME: "/home/dev/.config" });
	assert.equal(env.XDG_CONFIG_HOME, "/home/dev/.config");
	assert.equal(env.PI_NIGHT_RUN, undefined);
});

test("a child shell spawned with nightChildEnv sees the run policy", () => {
	// The regression this file exists for: assert the values in the child, not in
	// the process that set them.
	const env = nightChildEnv(run({ pacingDisabled: true }), process.env);
	const seen = execFileSync(
		"sh",
		["-c", "printenv XDG_CONFIG_HOME; printenv PI_NIGHT_RUN; printenv PI_USAGE_PACING"],
		{
			env: env as NodeJS.ProcessEnv,
			encoding: "utf-8",
		},
	);
	assert.deepEqual(seen.trim().split("\n"), ["/night/sandboxes/repo/run.agents/xdg", "1", "off"]);
});

test("buildNightContract points a child at the capability probe when there is one", () => {
	const withProbe = buildNightContract(run({ preflightPath: "/night/run.agents/sandbox-capabilities.md" }));
	assert.match(withProbe, /Sandbox capability probe: `\/night\/run\.agents\/sandbox-capabilities\.md`/);
	assert.doesNotMatch(buildNightContract(run()), /Sandbox capability probe/);
});

/** `applyNightRunEnv` reads the handshake from disk, so it needs a real one. */
let agentDir: string;
let previousAgentDir: string | undefined;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "night-run-env-"));
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	mkdirSync(join(agentDir, "night"), { recursive: true });
});

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
});

test("applyNightRunEnv sets the config home for a participant, so its own shells inherit it", () => {
	writeActiveNightRun(run({ sessionId: "coordinator", pacingDisabled: true }));
	const env: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: "/home/dev/.config" };
	const applied = applyNightRunEnv({ sessionId: "coordinator" }, env);
	assert.deepEqual(applied, ["XDG_CONFIG_HOME", "PI_TODO_PATH", "PI_USAGE_PACING"]);
	assert.equal(env.XDG_CONFIG_HOME, "/night/sandboxes/repo/run.agents/xdg");
	assert.equal(env.PI_TODO_PATH, "/night/todos");
	assert.equal(env.PI_USAGE_PACING, "off");
	// Idempotent: a second call has nothing left to change.
	assert.deepEqual(applyNightRunEnv({ sessionId: "coordinator" }, env), []);
});

test("applyNightRunEnv leaves a bystander session alone", () => {
	writeActiveNightRun(run({ sessionId: "coordinator", workspacePath: "/night/clone" }));
	const env: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: "/home/dev/.config" };
	assert.deepEqual(applyNightRunEnv({ sessionId: "someone-else", cwd: "/home/dev/src/repo" }, env), []);
	assert.equal(env.XDG_CONFIG_HOME, "/home/dev/.config");
});

test("the handshake round-trips the config home and the probe path", () => {
	writeActiveNightRun(run({ preflightPath: "/night/probe.md", pacingDisabled: true }));
	const body = JSON.parse(execFileSync("cat", [activeRunPath()], { encoding: "utf-8" }));
	assert.equal(body.configHome, "/night/sandboxes/repo/run.agents/xdg");
	assert.equal(body.preflightPath, "/night/probe.md");
	assert.equal(body.pacingDisabled, true);
	writeFileSync(join(agentDir, "night", "touched"), "");
});
