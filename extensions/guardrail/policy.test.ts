import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { evaluateBashCall } from "./policy.ts";
import type { GuardrailContext } from "./rules.ts";

const context: GuardrailContext = { home: "/Users/alice", cwd: "/Users/alice/src/project" };

function event(toolName: string, input: Record<string, unknown>): ToolCallEvent {
	return { type: "tool_call", toolCallId: "call-1", toolName, input } as ToolCallEvent;
}

test("blocks a destructive bash call and explains why", () => {
	const decision = evaluateBashCall(event("bash", { command: "rm -rf ~" }), { enabled: true, context });
	assert.equal(decision?.block, true);
	assert.match(decision?.reason ?? "", /home directory/);
	assert.match(decision?.reason ?? "", /Offending fragment: rm -rf ~/);
	assert.match(decision?.reason ?? "", /\/guardrail off/);
});

test("allows an ordinary bash call", () => {
	const decision = evaluateBashCall(event("bash", { command: "rm -rf node_modules" }), { enabled: true, context });
	assert.equal(decision, undefined);
});

test("blocks direct mutation through literal exec argv", () => {
	const decision = evaluateBashCall(event("exec", { argv: ["sed", "-i", "s/a/b/", "file.txt"] }), {
		enabled: true,
		context,
	});
	assert.equal(decision?.block, true);
	assert.match(decision?.reason ?? "", /'sed' in-place edit/);
});

test("blocks an exec interpreter program supplied on stdin", () => {
	const decision = evaluateBashCall(event("exec", { argv: ["python", "-"], stdin: 'open("file.txt", "w")' }), {
		enabled: true,
		context,
	});
	assert.match(decision?.reason ?? "", /inline 'python' program/);
});

test("allows exec script files and literal shell metacharacters", () => {
	assert.equal(
		evaluateBashCall(event("exec", { argv: ["python", "scripts/generate.py"] }), { enabled: true, context }),
		undefined,
	);
	assert.equal(
		evaluateBashCall(event("exec", { argv: ["printf", ">", "file.txt"] }), { enabled: true, context }),
		undefined,
	);
});

test("blocks a nested exec shell command through the normal policy", () => {
	const decision = evaluateBashCall(event("exec", { argv: ["bash", "-c", "echo x > file.txt"] }), {
		enabled: true,
		context,
	});
	assert.match(decision?.reason ?? "", /shell output redirection/);
});

test("does nothing when disabled", () => {
	const decision = evaluateBashCall(event("bash", { command: "rm -rf ~" }), { enabled: false, context });
	assert.equal(decision, undefined);
});

test("ignores non-bash tools", () => {
	const decision = evaluateBashCall(event("write", { path: "/tmp/x", content: "rm -rf ~" }), {
		enabled: true,
		context,
	});
	assert.equal(decision, undefined);
});

test("ignores a bash call without a string command", () => {
	const decision = evaluateBashCall(event("bash", { command: 42 }), { enabled: true, context });
	assert.equal(decision, undefined);
});

test("judges relative targets against the per-call cwd", () => {
	const call = event("bash", { command: "rm -rf usr", cwd: "/" });
	const decision = evaluateBashCall(call, { enabled: true, context });
	assert.match(decision?.reason ?? "", /system directory '\/usr'/);
});
