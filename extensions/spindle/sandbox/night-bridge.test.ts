import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { NIGHT_RUN_ENV } from "../../night-mode/night-run.ts";
import { activeNightSandboxRequest } from "./night-bridge.ts";

let dir: string;
let previous: string | undefined;
let previousMarker: string | undefined;

const writeActiveRun = (run: unknown): void => {
	mkdirSync(join(dir, "night"), { recursive: true });
	writeFileSync(join(dir, "night", "active.json"), JSON.stringify(run));
};

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "night-bridge-"));
	previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	previousMarker = process.env[NIGHT_RUN_ENV];
	delete process.env[NIGHT_RUN_ENV];
});

afterEach(() => {
	if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previous;
	if (previousMarker === undefined) delete process.env[NIGHT_RUN_ENV];
	else process.env[NIGHT_RUN_ENV] = previousMarker;
	rmSync(dir, { recursive: true, force: true });
});

test("no active run means no override", () => {
	assert.equal(activeNightSandboxRequest(), undefined);
});

test("an active run without a sandbox block means no override", () => {
	writeActiveRun({ startedAt: 1, reportPath: "/tmp/r.md", maxPullRequests: 3 });
	assert.equal(activeNightSandboxRequest(), undefined);
});

test("a subagent process picks the policy up from the handshake file", () => {
	writeActiveRun({
		startedAt: 1,
		reportPath: "/tmp/r.md",
		maxPullRequests: 3,
		sandbox: { mode: "workspace-write", allowWrite: ["/sandboxes/repo", ""] },
	});
	process.env[NIGHT_RUN_ENV] = "1";
	assert.deepEqual(activeNightSandboxRequest(), {
		mode: "workspace-write",
		allowWrite: ["/sandboxes/repo"],
	});
});

test("the coordinator session is a participant", () => {
	writeActiveRun({
		startedAt: 1,
		reportPath: "/tmp/r.md",
		maxPullRequests: 3,
		sessionId: "session-a",
		sandbox: { mode: "read-only" },
	});
	assert.deepEqual(activeNightSandboxRequest({ sessionId: "session-a" }), { mode: "read-only" });
});

test("a session inside the run's working copy is a participant", () => {
	writeActiveRun({
		startedAt: 1,
		reportPath: "/tmp/r.md",
		maxPullRequests: 3,
		workspacePath: "/sandboxes/repo/night",
		sandbox: { mode: "workspace-write" },
	});
	assert.deepEqual(activeNightSandboxRequest({ cwd: "/sandboxes/repo/night/sub/dir" }), {
		mode: "workspace-write",
	});
	assert.deepEqual(activeNightSandboxRequest({ cwd: "/sandboxes/repo/night.agents/agent-a-0" }), {
		mode: "workspace-write",
	});
});

test("an unrelated session started mid-run keeps its own policy", () => {
	writeActiveRun({
		startedAt: 1,
		reportPath: "/tmp/r.md",
		maxPullRequests: 3,
		sessionId: "session-a",
		workspacePath: "/sandboxes/repo/night",
		sandbox: { mode: "workspace-write" },
	});
	assert.equal(activeNightSandboxRequest({ sessionId: "session-b", cwd: "/Users/dev/src/repo" }), undefined);
});

test("the run's requested domains travel with the policy", () => {
	writeActiveRun({
		startedAt: 1,
		reportPath: "/tmp/r.md",
		maxPullRequests: 3,
		sandbox: {
			mode: "workspace-write",
			network: { allowedDomains: ["github.com", "", "*.github.com"] },
		},
	});
	process.env[NIGHT_RUN_ENV] = "1";
	assert.deepEqual(activeNightSandboxRequest(), {
		mode: "workspace-write",
		network: { allowedDomains: ["github.com", "*.github.com"] },
	});
});

test("an unknown mode in the handshake is ignored", () => {
	writeActiveRun({
		startedAt: 1,
		reportPath: "/tmp/r.md",
		maxPullRequests: 3,
		sandbox: { mode: "yolo" },
	});
	process.env[NIGHT_RUN_ENV] = "1";
	assert.equal(activeNightSandboxRequest(), undefined);
});
