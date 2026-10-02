import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { AgentWorkspace } from "../night-mode/agent-workspace.ts";
import { writeActiveNightRun, clearActiveNightRun, type ActiveNightRun } from "../night-mode/night-run.ts";
import { allocateNightWorkspaces, relocateWorkspacePaths, type NightWorkspaceRequest } from "./night-workspace.ts";

let dir: string;
let previousAgentDir: string | undefined;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "night-allocation-"));
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
});
afterEach(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(dir, { recursive: true, force: true });
});

const run: ActiveNightRun = {
	phase: "execution",
	startedAt: 1,
	reportPath: "/report",
	maxPullRequests: 0,
	workspacePath: "/captured",
};

const workspace: AgentWorkspace = {
	name: "agent-abc-0",
	path: "/night/sandboxes/repo.agents/agent-abc-0",
	base: "/night/sandboxes/repo",
	artifactsDir: "/night/sandboxes/repo.agents/agent-abc-0.artifacts",
};

test("allocation uses a supplied snapshot throughout global replacement", async () => {
	const requests: NightWorkspaceRequest[] = [{ index: 0, night: true }, { index: 1, night: true }, { index: 2 }];
	const snapshots: Array<ActiveNightRun | undefined> = [];
	const acquired = await allocateNightWorkspaces(requests, "run", dir, run, {
		acquire: async (name, _cwd, snapshot) => {
			snapshots.push(snapshot);
			writeActiveNightRun({ ...run, workspacePath: "/replacement" });
			return { ...workspace, name, path: `/captured/${name}` };
		},
	});
	assert.deepEqual(snapshots, [run, run]);
	assert.equal(acquired.length, 2);
	assert.match(requests[0].cwd!, /^\/captured\/agent-/);
	assert.equal(requests[2].cwd, undefined);
});

test("default allocation honors isolation requested by the global handshake", async () => {
	writeActiveNightRun({ ...run, workspacePath: join(dir, "unavailable") });
	const request: NightWorkspaceRequest = { index: 0, night: true };
	await assert.rejects(allocateNightWorkspaces([request], "run", dir), /isolation unavailable/);
	assert.equal(request.cwd, undefined);
});

test("isolated allocation failure releases partial workspaces without publishing cwd", async () => {
	for (const throws of [false, true]) {
		const requests: NightWorkspaceRequest[] = [
			{ index: 0, night: true, cwd: "/original" },
			{ index: 1, night: true },
		];
		const released: AgentWorkspace[] = [];
		let calls = 0;
		await assert.rejects(
			allocateNightWorkspaces(requests, "run", dir, run, {
				acquire: async () => {
					if (++calls === 1) return workspace;
					if (throws) throw new Error("allocation failed");
					return undefined;
				},
				release: async (item) => {
					released.push(item);
				},
			}),
			/isolation unavailable|allocation failed/,
		);
		assert.deepEqual(released, [workspace]);
		assert.equal(requests[0].cwd, "/original");
		assert.equal(requests[0].artifactsDir, undefined);
		assert.equal(requests[1].cwd, undefined);
	}
});

test("captured absence never picks up a subsequently active global run", async () => {
	writeActiveNightRun(run);
	const requests: NightWorkspaceRequest[] = [{ index: 0, night: true }];
	assert.deepEqual(await allocateNightWorkspaces(requests, "run", dir, undefined), []);
	assert.equal(requests[0].cwd, undefined);
	clearActiveNightRun();
	assert.deepEqual(await allocateNightWorkspaces(requests, "run", dir), []);
});

test("rollback attempts every cleanup even if one release fails synchronously", async () => {
	const requests = [0, 1, 2].map((index) => ({ index, night: true }));
	const released: string[] = [];
	let calls = 0;
	await assert.rejects(
		allocateNightWorkspaces(requests, "run", dir, run, {
			acquire: async (name) => {
				if (++calls === 3) throw new Error("original allocation failure");
				return { ...workspace, name };
			},
			release: (item) => {
				released.push(item.name);
				throw new Error("cleanup failure");
			},
		}),
		/original allocation failure/,
	);
	assert.equal(released.length, 2);
});

test("relocateWorkspacePaths points a declared file path at the surviving copy", () => {
	const result = relocateWorkspacePaths(
		{
			output: "Done.\nEvidence: file /night/sandboxes/repo.agents/agent-abc-0/slack-pass.md",
			error: "could not read /night/sandboxes/repo.agents/agent-abc-0/x.ts",
		},
		[workspace],
	);
	assert.equal(
		result.output,
		"Done.\nEvidence: file /night/sandboxes/repo.agents/agent-abc-0.artifacts/slack-pass.md",
	);
	assert.equal(result.error, "could not read /night/sandboxes/repo.agents/agent-abc-0.artifacts/x.ts");
});

test("relocateWorkspacePaths leaves a result alone when no workspace was allocated", () => {
	const original = { output: "Evidence: file /somewhere/else.md" };
	assert.equal(relocateWorkspacePaths(original, []), original);
});

test("relocateWorkspacePaths keeps unrelated paths untouched", () => {
	const result = relocateWorkspacePaths({ output: "wrote /night/sandboxes/repo/README.md" }, [workspace]);
	assert.equal(result.output, "wrote /night/sandboxes/repo/README.md");
});
