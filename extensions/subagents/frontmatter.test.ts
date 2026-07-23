import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFrontmatter, toAgentConfig } from "./frontmatter.ts";

test("parseFrontmatter extracts scalars, comma lists, and booleans", () => {
	const md = [
		"---",
		"name: worker",
		"description: Implementation agent",
		"model: claude-opus-4-8",
		"thinking: low",
		"tools: read, grep, find, ls, bash",
		"inheritSkills: false",
		"inheritProjectContext: true",
		"---",
		"",
		"You are `worker`.",
	].join("\n");

	const { data, body } = parseFrontmatter(md);
	assert.equal(data.name, "worker");
	assert.equal(data.description, "Implementation agent");
	assert.equal(data.model, "claude-opus-4-8");
	assert.deepEqual(data.tools, ["read", "grep", "find", "ls", "bash"]);
	assert.equal(data.inheritSkills, false);
	assert.equal(data.inheritProjectContext, true);
	assert.equal(body.trim(), "You are `worker`.");
});

test("parseFrontmatter returns whole doc as body when no frontmatter", () => {
	const { data, body } = parseFrontmatter("just a body\nno frontmatter");
	assert.deepEqual(data, {});
	assert.equal(body, "just a body\nno frontmatter");
});

test("parseFrontmatter ignores nested/list lines instead of throwing", () => {
	const md = ["---", "name: x", "nested:", "  key: value", "list:", "  - a", "  - b", "---", "body"].join("\n");
	const { data } = parseFrontmatter(md);
	assert.equal(data.name, "x");
	assert.equal(data.nested, undefined);
	assert.equal(data.list, undefined);
});

test("parseFrontmatter strips surrounding quotes", () => {
	const { data } = parseFrontmatter(['---', 'name: "quoted name"', "---", "b"].join("\n"));
	assert.equal(data.name, "quoted name");
});

test("toAgentConfig maps fields and normalizes enums", () => {
	const { data } = parseFrontmatter(
		[
			"---",
			"name: reviewer",
			"model: claude-sonnet-5",
			"thinking: medium",
			"systemPromptMode: replace",
			"tools: read, grep",
			"inheritSkills: false",
			"---",
			"body",
		].join("\n"),
	);
	const cfg = toAgentConfig(data, "fallback");
	assert.equal(cfg.name, "reviewer");
	assert.equal(cfg.model, "claude-sonnet-5");
	assert.equal(cfg.thinking, "medium");
	assert.equal(cfg.systemPromptMode, "replace");
	assert.deepEqual(cfg.tools, ["read", "grep"]);
	assert.equal(cfg.inheritSkills, false);
});

test("toAgentConfig falls back to file stem name and drops invalid enums", () => {
	const cfg = toAgentConfig({ systemPromptMode: "weird" }, "my-agent");
	assert.equal(cfg.name, "my-agent");
	assert.equal(cfg.systemPromptMode, undefined);
});

test("toAgentConfig handles single-item tools string", () => {
	const cfg = toAgentConfig({ name: "x", tools: "read" }, "x");
	assert.deepEqual(cfg.tools, ["read"]);
});

test("toAgentConfig parses output and defaultReads (list and single)", () => {
	const cfg = toAgentConfig({ name: "planner", output: "plan.md", defaultReads: ["context.md", "plan.md"] }, "planner");
	assert.equal(cfg.output, "plan.md");
	assert.deepEqual(cfg.defaultReads, ["context.md", "plan.md"]);
	const single = toAgentConfig({ name: "worker", defaultReads: "context.md" }, "worker");
	assert.deepEqual(single.defaultReads, ["context.md"]);
});
