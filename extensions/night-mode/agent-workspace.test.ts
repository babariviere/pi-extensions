import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
	acquireAgentWorkspace,
	agentWorkspaceName,
	agentWorkspacesRoot,
	releaseAgentWorkspace,
} from "./agent-workspace.ts";

describe("agentWorkspacesRoot", () => {
	test("sits beside the clone, not inside it", () => {
		assert.equal(
			agentWorkspacesRoot("/sandboxes/phishing/2026-08-29 2130"),
			"/sandboxes/phishing/2026-08-29 2130.agents",
		);
	});
});

describe("agentWorkspaceName", () => {
	test("keeps only what jj accepts and stays unique per index", () => {
		assert.equal(agentWorkspaceName("01a0-48e1_fd33", 2), "agent-01a048e1-2");
		assert.notEqual(agentWorkspaceName("abc", 0), agentWorkspaceName("abc", 1));
	});

	test("falls back to a literal when the id has nothing usable", () => {
		assert.equal(agentWorkspaceName("---", 0), "agent-run-0");
	});
});

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "night-agent-ws-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("acquireAgentWorkspace", () => {
	test("adds a jj workspace and brings the local config along", async () => {
		const base = join(dir, "clone");
		mkdirSync(join(base, ".jj"), { recursive: true });
		writeFileSync(join(base, "mise.local.toml"), "secret");
		const calls: string[][] = [];

		const workspace = await acquireAgentWorkspace({
			base,
			root: agentWorkspacesRoot(base),
			name: "agent-abc-0",
			copyFiles: ["mise.local.toml", "absent.toml"],
			exec: (command, args, cwd) => {
				calls.push([command, ...args, cwd]);
				mkdirSync(args[args.length - 1], { recursive: true });
			},
		});

		assert.ok(workspace);
		assert.equal(workspace.path, join(`${base}.agents`, "agent-abc-0"));
		assert.deepEqual(calls[0].slice(0, 4), ["jj", "workspace", "add", "--name"]);
		assert.equal(calls[0][calls[0].length - 1], base);
		assert.equal(readFileSync(join(workspace.path, "mise.local.toml"), "utf-8"), "secret");
		assert.equal(existsSync(join(workspace.path, "absent.toml")), false);
	});

	test("declines a clone that is not a jj repository", async () => {
		const base = join(dir, "plain");
		mkdirSync(base, { recursive: true });
		const workspace = await acquireAgentWorkspace({
			base,
			root: agentWorkspacesRoot(base),
			name: "agent-abc-0",
			exec: () => assert.fail("should not shell out"),
		});
		assert.equal(workspace, undefined);
	});

	test("degrades to undefined when jj refuses", async () => {
		const base = join(dir, "clone");
		mkdirSync(join(base, ".jj"), { recursive: true });
		const workspace = await acquireAgentWorkspace({
			base,
			root: agentWorkspacesRoot(base),
			name: "agent-abc-0",
			exec: () => {
				throw new Error("jj: no such workspace");
			},
		});
		assert.equal(workspace, undefined);
	});
});

describe("releaseAgentWorkspace", () => {
	test("snapshots, forgets, then removes the directory", async () => {
		const base = join(dir, "clone");
		const path = join(dir, "clone.agents", "agent-abc-0");
		mkdirSync(path, { recursive: true });
		const calls: string[][] = [];

		await releaseAgentWorkspace(
			{ name: "agent-abc-0", path, base },
			{ exec: (command, args, cwd) => void calls.push([command, ...args, cwd]) },
		);

		assert.deepEqual(calls, [
			["jj", "status", path],
			["jj", "workspace", "forget", "agent-abc-0", base],
		]);
		assert.equal(existsSync(path), false);
	});

	test("still removes the directory when jj fails", async () => {
		const base = join(dir, "clone");
		const path = join(dir, "clone.agents", "agent-abc-0");
		mkdirSync(path, { recursive: true });

		await releaseAgentWorkspace(
			{ name: "agent-abc-0", path, base },
			{
				exec: () => {
					throw new Error("jj: broken");
				},
			},
		);

		assert.equal(existsSync(path), false);
	});
});
