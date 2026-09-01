import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentWorkspace } from "../../night-mode/agent-workspace.ts";
import { relocateWorkspacePaths } from "./night-workspace.ts";

const workspace: AgentWorkspace = {
	name: "agent-abc-0",
	path: "/night/sandboxes/repo.agents/agent-abc-0",
	base: "/night/sandboxes/repo",
	artifactsDir: "/night/sandboxes/repo.agents/agent-abc-0.artifacts",
};

test("relocateWorkspacePaths points a declared file path at the surviving copy", () => {
	const result = relocateWorkspacePaths(
		{
			output: "Done.\nEvidence: file /night/sandboxes/repo.agents/agent-abc-0/slack-pass.md",
			error: "could not read /night/sandboxes/repo.agents/agent-abc-0/x.ts",
		},
		[workspace],
	);
	assert.equal(result.output, "Done.\nEvidence: file /night/sandboxes/repo.agents/agent-abc-0.artifacts/slack-pass.md");
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
