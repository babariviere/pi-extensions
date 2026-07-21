import assert from "node:assert/strict";
import { test } from "node:test";
import { type DiscoveredAgent } from "./discovery.ts";
import { SUBMIT_RESULT_TOOL } from "./constants.ts";
import { applyThinkingSuffix, buildChildArgs, qualifyModel, resultToolPath } from "./pi-args.ts";

function agent(overrides: Partial<DiscoveredAgent["config"]> = {}, systemPrompt = "You are worker."): DiscoveredAgent {
	return {
		config: { name: "worker", ...overrides },
		systemPrompt,
		sourcePath: "/x/worker.md",
		scope: "user",
	};
}

const opts = {
	sessionFile: "/tmp/run/worker-0.session.jsonl",
	outputPath: "/tmp/run/worker-0.md",
	systemPromptFile: "/tmp/run/worker-0.prompt.md",
};

test("applyThinkingSuffix appends when missing and skips when present or off", () => {
	assert.equal(applyThinkingSuffix("model", "high"), "model:high");
	assert.equal(applyThinkingSuffix("model:low", "high"), "model:low");
	assert.equal(applyThinkingSuffix("model", "off"), "model");
	assert.equal(applyThinkingSuffix(undefined, "high"), undefined);
	assert.equal(applyThinkingSuffix("model", undefined), "model");
});

test("buildChildArgs always sets session and instructs the agent to submit its result", () => {
	const args = buildChildArgs(agent(), "do the thing", opts);
	assert.deepEqual(args.slice(0, 2), ["--session", opts.sessionFile]);
	const taskArg = args[args.length - 1];
	assert.ok(taskArg.startsWith("Task: do the thing"));
	assert.ok(taskArg.includes(SUBMIT_RESULT_TOOL));
	// The output path must never leak to the agent; it travels via env instead.
	assert.ok(!taskArg.includes(opts.outputPath));
});

test("buildChildArgs loads the result-tool extension via -e", () => {
	const args = buildChildArgs(agent(), "t", opts);
	const idx = args.indexOf("--extension");
	assert.ok(idx !== -1);
	assert.equal(args[idx + 1], resultToolPath());
	assert.ok(resultToolPath().endsWith("result-tool.ts"));
});

test("buildChildArgs appends the result tool to a declared tools allowlist", () => {
	const args = buildChildArgs(agent({ tools: ["read", "grep"] }), "t", opts);
	const toolsIdx = args.indexOf("--tools");
	assert.equal(args[toolsIdx + 1], `read,grep,${SUBMIT_RESULT_TOOL}`);
});

test("buildChildArgs does not duplicate the result tool if already allowlisted", () => {
	const args = buildChildArgs(agent({ tools: ["read", SUBMIT_RESULT_TOOL] }), "t", opts);
	const toolsIdx = args.indexOf("--tools");
	assert.equal(args[toolsIdx + 1], `read,${SUBMIT_RESULT_TOOL}`);
});

test("buildChildArgs omits --tools when the agent declares no allowlist", () => {
	const args = buildChildArgs(agent({}), "t", opts);
	assert.ok(!args.includes("--tools"));
});

test("qualifyModel prefixes a bare model with the default provider only when needed", () => {
	assert.equal(qualifyModel("claude-opus-4-8", "anthropic"), "anthropic/claude-opus-4-8");
	assert.equal(qualifyModel("anthropic/claude-opus-4-8", "openai"), "anthropic/claude-opus-4-8");
	assert.equal(qualifyModel(undefined, "anthropic"), undefined);
	assert.equal(qualifyModel("claude-opus-4-8", undefined), "claude-opus-4-8");
	assert.equal(qualifyModel("", "anthropic"), "");
});

test("buildChildArgs qualifies a bare model with the default provider before the thinking suffix", () => {
	const args = buildChildArgs(
		agent({ model: "claude-opus-4-8", thinking: "low" }),
		"t",
		{ ...opts, defaultProvider: "anthropic" },
	);
	const modelIdx = args.indexOf("--model");
	assert.equal(args[modelIdx + 1], "anthropic/claude-opus-4-8:low");
});

test("buildChildArgs leaves an already-qualified model untouched", () => {
	const args = buildChildArgs(
		agent({ model: "anthropic/claude-opus-4-8", thinking: "low" }),
		"t",
		{ ...opts, defaultProvider: "openai" },
	);
	const modelIdx = args.indexOf("--model");
	assert.equal(args[modelIdx + 1], "anthropic/claude-opus-4-8:low");
});

test("buildChildArgs adds model with thinking suffix and tools list", () => {
	const args = buildChildArgs(agent({ model: "claude-opus-4-8", thinking: "low", tools: ["read", "bash"] }), "t", opts);
	const modelIdx = args.indexOf("--model");
	assert.equal(args[modelIdx + 1], "claude-opus-4-8:low");
	const toolsIdx = args.indexOf("--tools");
	assert.equal(args[toolsIdx + 1], `read,bash,${SUBMIT_RESULT_TOOL}`);
});

test("buildChildArgs modelOverride takes precedence over the agent's frontmatter model", () => {
	const args = buildChildArgs(
		agent({ model: "claude-opus-4-8", thinking: "low" }),
		"t",
		{ ...opts, defaultProvider: "anthropic", modelOverride: "claude-sonnet-5" },
	);
	const modelIdx = args.indexOf("--model");
	// Override is qualified with the default provider and keeps the agent's thinking.
	assert.equal(args[modelIdx + 1], "anthropic/claude-sonnet-5:low");
});

test("buildChildArgs thinkingOverride takes precedence over the agent's frontmatter thinking", () => {
	const args = buildChildArgs(
		agent({ model: "claude-opus-4-8", thinking: "low" }),
		"t",
		{ ...opts, defaultProvider: "anthropic", thinkingOverride: "high" },
	);
	const modelIdx = args.indexOf("--model");
	assert.equal(args[modelIdx + 1], "anthropic/claude-opus-4-8:high");
});

test("buildChildArgs modelOverride works when the agent declares no model", () => {
	const args = buildChildArgs(agent({}), "t", { ...opts, defaultProvider: "anthropic", modelOverride: "claude-sonnet-5" });
	const modelIdx = args.indexOf("--model");
	assert.equal(args[modelIdx + 1], "anthropic/claude-sonnet-5");
});

test("buildChildArgs honors systemPromptMode (replace vs append)", () => {
	const replace = buildChildArgs(agent({ systemPromptMode: "replace" }), "t", opts);
	assert.ok(replace.includes("--system-prompt"));
	assert.ok(!replace.includes("--append-system-prompt"));

	// Unset defaults to replace.
	const unset = buildChildArgs(agent({}), "t", opts);
	assert.ok(unset.includes("--system-prompt"));
	assert.ok(!unset.includes("--append-system-prompt"));

	const append = buildChildArgs(agent({ systemPromptMode: "append" }), "t", opts);
	assert.ok(append.includes("--append-system-prompt"));
	assert.ok(!append.some((a) => a === "--system-prompt"));
});

test("buildChildArgs adds --no-context-files only when inheritProjectContext is false", () => {
	assert.ok(buildChildArgs(agent({ inheritProjectContext: false }), "t", opts).includes("--no-context-files"));
	assert.ok(!buildChildArgs(agent({ inheritProjectContext: true }), "t", opts).includes("--no-context-files"));
	assert.ok(!buildChildArgs(agent({}), "t", opts).includes("--no-context-files"));
});

test("buildChildArgs omits the system prompt flag when body is empty", () => {
	const args = buildChildArgs(agent({}, "   "), "t", opts);
	assert.ok(!args.includes("--system-prompt"));
	assert.ok(!args.includes("--append-system-prompt"));
});

test("buildChildArgs adds --no-skills only when inheritSkills is false", () => {
	assert.ok(buildChildArgs(agent({ inheritSkills: false }), "t", opts).includes("--no-skills"));
	assert.ok(!buildChildArgs(agent({ inheritSkills: true }), "t", opts).includes("--no-skills"));
	assert.ok(!buildChildArgs(agent({}), "t", opts).includes("--no-skills"));
});
