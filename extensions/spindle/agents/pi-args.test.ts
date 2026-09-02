import assert from "node:assert/strict";
import { test } from "node:test";
import { type DiscoveredAgent } from "./discovery.ts";
import { SANDBOX_MODE_FLAG, TASK_FILE_FLAG } from "./constants.ts";
import {
	buildChildArgs,
	childExtensionPath,
	extractThinkingSuffix,
	qualifyModel,
	stripThinkingSuffix,
} from "./pi-args.ts";

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
	systemPromptFile: "/tmp/run/worker-0.prompt.md",
};

test("stripThinkingSuffix removes a known thinking suffix and leaves other colons alone", () => {
	assert.equal(stripThinkingSuffix("claude-opus-4-8:low"), "claude-opus-4-8");
	assert.equal(stripThinkingSuffix("anthropic/claude-opus-4-8:high"), "anthropic/claude-opus-4-8");
	assert.equal(stripThinkingSuffix("claude-opus-4-8"), "claude-opus-4-8");
	// A colon that is not a thinking level is preserved.
	assert.equal(stripThinkingSuffix("provider:model"), "provider:model");
});

test("extractThinkingSuffix returns the level only for a valid trailing suffix", () => {
	assert.equal(extractThinkingSuffix("model:high"), "high");
	assert.equal(extractThinkingSuffix("model:low"), "low");
	assert.equal(extractThinkingSuffix("model"), undefined);
	assert.equal(extractThinkingSuffix("provider/model"), undefined);
	assert.equal(extractThinkingSuffix("model:bogus"), undefined);
});

test("buildChildArgs always sets session and instructs the agent to answer in its final message", () => {
	const args = buildChildArgs(agent(), "do the thing", opts);
	assert.deepEqual(args.slice(0, 2), ["--session", opts.sessionFile]);
	const taskArg = args[args.length - 1];
	assert.ok(taskArg.startsWith("Task: do the thing"));
	assert.ok(taskArg.includes("final message"));
});

test("buildChildArgs points the child at its deliverables directory when the host gave one", () => {
	const args = buildChildArgs(agent(), "do the thing", { ...opts, artifactsDir: "/night/agents/worker-0.artifacts" });
	const taskArg = args[args.length - 1];
	assert.ok(taskArg.includes("Deliverables directory: `/night/agents/worker-0.artifacts`"));
});

test("buildChildArgs prepends a read-first instruction listing the context files", () => {
	const args = buildChildArgs(agent(), "do the thing", { ...opts, reads: [".pi/goal/research.md", "src/x.ts"] });
	const taskArg = args[args.length - 1];
	assert.ok(taskArg.includes("Read these files first for context: `.pi/goal/research.md`, `src/x.ts`."));
	// The original task still follows the read-first preface.
	assert.ok(taskArg.includes("do the thing"));
});

test("buildChildArgs omits the read-first instruction when reads is empty", () => {
	const args = buildChildArgs(agent(), "do the thing", { ...opts, reads: [] });
	const taskArg = args[args.length - 1];
	assert.ok(!taskArg.includes("Read these files first"));
});

test("buildChildArgs hands the task over as a file instead of an inline arg", () => {
	const taskFile = "/tmp/run/worker-0.task.md";
	const args = buildChildArgs(agent(), "do the thing", { ...opts, includeTask: false, taskFile });
	// The child reads the task itself, so no inline task arg; the session flag
	// still is present.
	assert.ok(!args.some((a) => a.startsWith("Task:")));
	assert.ok(args.includes("--session"));
	const idx = args.indexOf(`--${TASK_FILE_FLAG}`);
	assert.ok(idx !== -1);
	assert.equal(args[idx + 1], taskFile);
	// Spindle registers the flag itself: an unsandboxed agent needs no injected
	// child extension to accept a task.
	assert.equal(args.includes("--extension"), false);
});

test("buildChildArgs loads the child extension only for a sandboxed agent", () => {
	assert.ok(!buildChildArgs(agent(), "t", opts).includes("--extension"));
	const args = buildChildArgs(agent({ sandbox: "read-only" }), "t", opts);
	const idx = args.indexOf("--extension");
	assert.ok(idx !== -1);
	assert.equal(args[idx + 1], childExtensionPath());
	assert.ok(childExtensionPath().endsWith("child-extension.ts"));
});

test("buildChildArgs never filters the child's tools", () => {
	// A subagent keeps the parent's whole toolset; its sandbox mode bounds it.
	for (const config of [{}, { sandbox: "read-only" as const }]) {
		assert.equal(buildChildArgs(agent(config), "t", opts).includes("--tools"), false);
	}
});

test("qualifyModel prefixes a bare model with the default provider only when needed", () => {
	assert.equal(qualifyModel("claude-opus-4-8", "anthropic"), "anthropic/claude-opus-4-8");
	assert.equal(qualifyModel("anthropic/claude-opus-4-8", "openai"), "anthropic/claude-opus-4-8");
	assert.equal(qualifyModel(undefined, "anthropic"), undefined);
	assert.equal(qualifyModel("claude-opus-4-8", undefined), "claude-opus-4-8");
	assert.equal(qualifyModel("", "anthropic"), "");
});

test("buildChildArgs qualifies a bare model and passes thinking via --thinking", () => {
	const args = buildChildArgs(agent({ model: "claude-opus-4-8", thinking: "low" }), "t", {
		...opts,
		defaultProvider: "anthropic",
	});
	const modelIdx = args.indexOf("--model");
	assert.equal(args[modelIdx + 1], "anthropic/claude-opus-4-8");
	const thinkingIdx = args.indexOf("--thinking");
	assert.equal(args[thinkingIdx + 1], "low");
});

test("buildChildArgs leaves an already-qualified model untouched", () => {
	const args = buildChildArgs(agent({ model: "anthropic/claude-opus-4-8", thinking: "low" }), "t", {
		...opts,
		defaultProvider: "openai",
	});
	const modelIdx = args.indexOf("--model");
	assert.equal(args[modelIdx + 1], "anthropic/claude-opus-4-8");
});

test("buildChildArgs passes thinking via --thinking even when the agent declares no model", () => {
	const args = buildChildArgs(agent({ thinking: "high" }), "t", { ...opts, defaultProvider: "anthropic" });
	assert.ok(!args.includes("--model"));
	const thinkingIdx = args.indexOf("--thinking");
	assert.equal(args[thinkingIdx + 1], "high");
});

test("buildChildArgs omits --thinking when thinking is unset or off", () => {
	assert.ok(!buildChildArgs(agent({ model: "claude-opus-4-8" }), "t", opts).includes("--thinking"));
	assert.ok(!buildChildArgs(agent({ model: "claude-opus-4-8", thinking: "off" }), "t", opts).includes("--thinking"));
});

test("buildChildArgs adds the model without a thinking suffix", () => {
	const args = buildChildArgs(agent({ model: "claude-opus-4-8", thinking: "low" }), "t", opts);
	const modelIdx = args.indexOf("--model");
	assert.equal(args[modelIdx + 1], "claude-opus-4-8");
	const thinkingIdx = args.indexOf("--thinking");
	assert.equal(args[thinkingIdx + 1], "low");
});

test("buildChildArgs modelOverride takes precedence over the agent's frontmatter model", () => {
	const args = buildChildArgs(agent({ model: "claude-opus-4-8", thinking: "low" }), "t", {
		...opts,
		defaultProvider: "anthropic",
		modelOverride: "claude-sonnet-5",
	});
	const modelIdx = args.indexOf("--model");
	// Override is qualified with the default provider and keeps the agent's thinking.
	assert.equal(args[modelIdx + 1], "anthropic/claude-sonnet-5");
	const thinkingIdx = args.indexOf("--thinking");
	assert.equal(args[thinkingIdx + 1], "low");
});

test("buildChildArgs thinkingOverride takes precedence over the agent's frontmatter thinking", () => {
	const args = buildChildArgs(agent({ model: "claude-opus-4-8", thinking: "low" }), "t", {
		...opts,
		defaultProvider: "anthropic",
		thinkingOverride: "high",
	});
	const modelIdx = args.indexOf("--model");
	assert.equal(args[modelIdx + 1], "anthropic/claude-opus-4-8");
	const thinkingIdx = args.indexOf("--thinking");
	assert.equal(args[thinkingIdx + 1], "high");
});

test("buildChildArgs takes the thinking level from a suffix embedded in the model override", () => {
	const args = buildChildArgs(agent({ thinking: "low" }), "t", {
		...opts,
		defaultProvider: "anthropic",
		modelOverride: "claude-sonnet-5:high",
	});
	const modelIdx = args.indexOf("--model");
	assert.equal(args[modelIdx + 1], "anthropic/claude-sonnet-5");
	const thinkingIdx = args.indexOf("--thinking");
	assert.equal(args[thinkingIdx + 1], "high");
});

test("buildChildArgs modelOverride works when the agent declares no model", () => {
	const args = buildChildArgs(agent({}), "t", {
		...opts,
		defaultProvider: "anthropic",
		modelOverride: "claude-sonnet-5",
	});
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

test("buildChildArgs forwards a declared sandbox mode as the floor flag", () => {
	const args = buildChildArgs(agent({ sandbox: "read-only" }), "do it", opts);
	const flagIdx = args.indexOf(`--${SANDBOX_MODE_FLAG}`);
	assert.ok(flagIdx !== -1);
	assert.equal(args[flagIdx + 1], "read-only");
	// The child extension is what makes pi accept the flag at all.
	assert.ok(args.includes("--extension"));
	assert.equal(args[args.indexOf("--extension") + 1], childExtensionPath());
	// A sandboxed agent keeps every tool: the kernel does the restricting.
	assert.equal(args.includes("--tools"), false);
	assert.equal(args.filter((a) => a === "--extension").length, 1);
});

test("buildChildArgs sends no sandbox flag when the agent declares no mode", () => {
	const args = buildChildArgs(agent(), "do it", opts);
	assert.equal(args.includes(`--${SANDBOX_MODE_FLAG}`), false);
	assert.equal(args.includes("--extension"), false);
});
