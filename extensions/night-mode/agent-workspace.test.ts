import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
	acquireAgentWorkspace,
	agentArtifactsDir,
	agentWorkspaceName,
	agentWorkspacesRoot,
	copyWorkspaceArtifacts,
	parseChangedPaths,
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

describe("agentArtifactsDir", () => {
	test("is a sibling of the workspace, so removing the workspace leaves it", () => {
		const root = "/sandboxes/phishing/2026-08-29 2130.agents";
		const artifacts = agentArtifactsDir(root, "agent-abc-0");
		assert.equal(artifacts, join(root, "agent-abc-0.artifacts"));
		assert.ok(!artifacts.startsWith(join(root, "agent-abc-0/")));
	});
});

describe("agentWorkspaceName", () => {
	test("keeps only what jj accepts and stays unique per index", () => {
		assert.match(agentWorkspaceName("01a0-48e1_fd33", 2), /^agent-[0-9a-f]{8}-2$/);
		assert.notEqual(agentWorkspaceName("abc", 0), agentWorkspaceName("abc", 1));
	});

	test("is stable for one run id", () => {
		assert.equal(agentWorkspaceName("run-1", 0), agentWorkspaceName("run-1", 0));
	});

	test("separates run ids that share a timestamp prefix", () => {
		// Run ids start with the date, so slicing the id itself gave every subagent
		// of a night the same workspace name.
		const first = agentWorkspaceName("2026-09-01T18-22-04-001Z_a1b2c3", 0);
		const second = agentWorkspaceName("2026-09-01T21-40-11-777Z_d4e5f6", 0);
		assert.notEqual(first, second);
	});
});

describe("parseChangedPaths", () => {
	test("takes added, modified and copied paths and skips deletions and renames", () => {
		const paths = parseChangedPaths(
			["A notes/slack-pass.md", "M src/app.ts", "C copy.ts", "D gone.ts", "R {old => new}.ts", ""].join("\n"),
		);
		assert.deepEqual(paths, ["notes/slack-pass.md", "src/app.ts", "copy.ts"]);
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

	test("creates the artifacts directory the child is pointed at", async () => {
		const base = join(dir, "clone");
		mkdirSync(join(base, ".jj"), { recursive: true });

		const workspace = await acquireAgentWorkspace({
			base,
			root: agentWorkspacesRoot(base),
			name: "agent-abc-0",
			exec: (_command, args) => {
				mkdirSync(args[args.length - 1], { recursive: true });
			},
		});

		assert.ok(workspace);
		assert.equal(workspace.artifactsDir, join(`${base}.agents`, "agent-abc-0.artifacts"));
		assert.equal(existsSync(workspace.artifactsDir), true);
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

/** A workspace triple pointing inside the test's temp dir. */
function fixture(root: string, name = "agent-abc-0") {
	const workspace = {
		name,
		path: join(root, name),
		base: join(dir, "clone"),
		artifactsDir: agentArtifactsDir(root, name),
	};
	mkdirSync(workspace.path, { recursive: true });
	mkdirSync(workspace.artifactsDir, { recursive: true });
	return workspace;
}

describe("copyWorkspaceArtifacts", () => {
	test("copies what the child changed, keeping the relative layout", async () => {
		const workspace = fixture(join(dir, "clone.agents"));
		mkdirSync(join(workspace.path, "notes"), { recursive: true });
		writeFileSync(join(workspace.path, "notes/triage.md"), "long write-up");

		const copied = await copyWorkspaceArtifacts(workspace, { capture: () => "A notes/triage.md\nD gone.md\n" });

		assert.deepEqual(copied, ["notes/triage.md"]);
		assert.equal(readFileSync(join(workspace.artifactsDir, "notes/triage.md"), "utf-8"), "long write-up");
	});

	test("leaves a file the child already wrote to the artifacts directory alone", async () => {
		const workspace = fixture(join(dir, "clone.agents"));
		writeFileSync(join(workspace.path, "report.md"), "workspace copy");
		writeFileSync(join(workspace.artifactsDir, "report.md"), "deliverable");

		await copyWorkspaceArtifacts(workspace, { capture: () => "M report.md\n" });

		assert.equal(readFileSync(join(workspace.artifactsDir, "report.md"), "utf-8"), "deliverable");
	});

	test("gives up quietly when jj cannot report a diff", async () => {
		const workspace = fixture(join(dir, "clone.agents"));
		const copied = await copyWorkspaceArtifacts(workspace, {
			capture: () => {
				throw new Error("jj: broken");
			},
		});
		assert.deepEqual(copied, []);
	});
});

describe("releaseAgentWorkspace", () => {
	test("snapshots, rescues the child's files, forgets, then removes the directory", async () => {
		const workspace = fixture(join(dir, "clone.agents"));
		writeFileSync(join(workspace.path, "slack-pass.md"), "1059 lines");
		const calls: string[][] = [];

		await releaseAgentWorkspace(workspace, {
			exec: (command, args, cwd) => void calls.push([command, ...args, cwd]),
			capture: () => "A slack-pass.md\n",
		});

		assert.deepEqual(calls, [
			["jj", "status", workspace.path],
			["jj", "workspace", "forget", workspace.name, workspace.base],
		]);
		// The point of the whole mechanism: the workspace is gone, the file is not.
		assert.equal(existsSync(workspace.path), false);
		assert.equal(readFileSync(join(workspace.artifactsDir, "slack-pass.md"), "utf-8"), "1059 lines");
	});

	test("still removes the directory when jj fails", async () => {
		const workspace = fixture(join(dir, "clone.agents"));

		await releaseAgentWorkspace(workspace, {
			exec: () => {
				throw new Error("jj: broken");
			},
			capture: () => {
				throw new Error("jj: broken");
			},
		});

		assert.equal(existsSync(workspace.path), false);
	});
});

describe("releaseAgentWorkspace artifacts hygiene", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "agent-artifacts-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const workspaceAt = (root: string) => {
		const path = join(root, "agent-ab12-0");
		const artifactsDir = join(root, "agent-ab12-0.artifacts");
		mkdirSync(path, { recursive: true });
		mkdirSync(artifactsDir, { recursive: true });
		return { name: "agent-ab12-0", path, base: root, artifactsDir };
	};

	test("removes the artifacts directory when there was nothing to rescue", async () => {
		const workspace = workspaceAt(join(dir, "clone.agents"));
		await releaseAgentWorkspace(workspace, { exec: () => {}, capture: () => "" });
		// A night of a few hundred subagents used to leave a few hundred empty ones.
		assert.equal(existsSync(workspace.artifactsDir), false);
	});

	test("keeps an artifacts directory the child wrote into itself", async () => {
		const workspace = workspaceAt(join(dir, "clone.agents"));
		writeFileSync(join(workspace.artifactsDir, "insights.md"), "kept");
		await releaseAgentWorkspace(workspace, { exec: () => {}, capture: () => "" });
		assert.equal(readFileSync(join(workspace.artifactsDir, "insights.md"), "utf-8"), "kept");
	});
});
