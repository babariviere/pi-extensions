import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { discoverAgents } from "./discovery.ts";

let root: string;
let userDir: string;
let projectDir: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "subagents-discovery-"));
	userDir = join(root, "user", "agents");
	projectDir = join(root, "project", ".pi", "agents");
	mkdirSync(userDir, { recursive: true });
	mkdirSync(projectDir, { recursive: true });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function agentFile(dir: string, file: string, name: string, extra = ""): void {
	const full = join(dir, file);
	mkdirSync(join(full, ".."), { recursive: true });
	writeFileSync(full, `---\nname: ${name}\ndescription: ${name} desc\n${extra}---\nBody for ${name}.\n`);
}

test("discovers user agents and parses body as system prompt", () => {
	agentFile(userDir, "worker.md", "worker");
	const agents = discoverAgents(userDir, projectDir);
	assert.equal(agents.length, 1);
	assert.equal(agents[0].config.name, "worker");
	assert.equal(agents[0].scope, "user");
	assert.equal(agents[0].systemPrompt, "Body for worker.");
});

test("project scope overrides user scope on name collision", () => {
	agentFile(userDir, "worker.md", "worker", "model: user-model\n");
	agentFile(projectDir, "worker.md", "worker", "model: project-model\n");
	const agents = discoverAgents(userDir, projectDir);
	assert.equal(agents.length, 1);
	assert.equal(agents[0].scope, "project");
	assert.equal(agents[0].config.model, "project-model");
});

test("discovery is recursive and ignores non-md files", () => {
	agentFile(userDir, join("nested", "planner.md"), "planner");
	writeFileSync(join(userDir, "notes.txt"), "not an agent");
	const agents = discoverAgents(userDir, projectDir);
	assert.deepEqual(
		agents.map((a) => a.config.name),
		["planner"],
	);
});

test("a malformed file does not crash discovery", () => {
	agentFile(userDir, "good.md", "good");
	writeFileSync(join(userDir, "bad.md"), "\uFEFF---\nname:\n---\n"); // empty name -> skipped
	const agents = discoverAgents(userDir, projectDir);
	assert.ok(agents.some((a) => a.config.name === "good"));
});

test("missing directories yield an empty list", () => {
	const agents = discoverAgents(join(root, "nope"), join(root, "nope2"));
	assert.deepEqual(agents, []);
});
