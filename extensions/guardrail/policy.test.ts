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

test("blocks root searches through bash, exec, and codemode-nested calls", () => {
	for (const call of [
		event("bash", { command: "find / -name x" }),
		event("bash", { command: "fd /" }),
		event("exec", { argv: ["fd", ".", "/"] }),
		{ ...event("bash", { command: "find /" }), parentToolCallId: "codemode" },
		event("bash", { command: "fd foo", cwd: "/" }),
	]) {
		const decision = evaluateBashCall(call, { enabled: true, context });
		assert.equal(decision?.block, true);
		assert.match(decision?.reason ?? "", /choose a project or a specific directory/);
		assert.equal(evaluateBashCall(call, { enabled: false, context }), undefined);
	}
});

test("root-search scope leaves other command rules unchanged", () => {
	for (const command of [
		"rm -rf /",
		"sed -i s/a/b/ file",
		"echo x > file",
		"perl -e 'print 1'",
		"bash -c 'rm -rf /'",
	]) {
		assert.equal(
			evaluateBashCall(event("bash", { command }), { enabled: true, context, scope: "root-search" }),
			undefined,
		);
	}
	for (const call of [
		event("bash", { command: "rm -rf /; find /" }),
		event("bash", { command: "find / > file" }),
		event("exec", { argv: ["bash", "-c", "fd . /"] }),
		event("jobs", { action: "start", command: "find /" }),
	]) {
		assert.match(
			evaluateBashCall(call, { enabled: true, context, scope: "root-search" })?.reason ?? "",
			/filesystem root/,
		);
	}
});

test("filesystem scope protects home, system, metadata and variable deletion targets", () => {
	for (const command of [
		"rm -rf ~",
		"rm -rf /",
		"rm -rf /Users/bob",
		"rm -rf /home/bob",
		"rm -rf /usr",
		"rm -rf /*",
		"rm -rf $HOME/*",
		"rm -rf .git",
		"rm -rf .jj",
		"rm -rf $DIR",
		"bash -c 'rm -rf ~'",
		"find /",
		"fd . /",
	]) {
		for (const call of [
			event("bash", { command }),
			event("jobs", { action: "start", command }),
			event("exec", { argv: ["sh", "-c", command] }),
		]) {
			const decision = evaluateBashCall(call, { enabled: true, context, scope: "filesystem" });
			assert.equal(decision?.block, true, command);
			assert.doesNotMatch(decision?.reason ?? "", /guardrail off/);
		}
	}
	for (const command of [
		"rm -rf ./build",
		"rm -rf /Users/bob/src/project/build",
		"find . -name x",
		"sed -i s/a/b/ file",
		"echo x > file",
		"perl -e 'print 1'",
		"chmod -R 755 scripts",
	]) {
		assert.equal(
			evaluateBashCall(event("bash", { command }), { enabled: true, context, scope: "filesystem" }),
			undefined,
			command,
		);
	}
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

test("allows an exec Python program supplied on stdin", () => {
	const decision = evaluateBashCall(event("exec", { argv: ["python", "-"], stdin: 'open("file.txt", "w")' }), {
		enabled: true,
		context,
	});
	assert.equal(decision, undefined);
});

test("allows inline Python through bash, exec, and codemode-nested calls", () => {
	for (const call of [
		event("bash", { command: "python -c 'print(1)'" }),
		event("exec", { argv: ["python3", "-c", "print(1)"] }),
		{ ...event("bash", { command: "python - <<'PY'\nprint(1)\nPY" }), parentToolCallId: "codemode" },
	]) {
		assert.equal(evaluateBashCall(call, { enabled: true, context }), undefined);
	}
});

test("allows the CODEOWNERS validation heredoc from a nested bash call", () => {
	const command = `python3 - <<'PY'
from pathlib import Path
import re
lines = Path('.github/CODEOWNERS').read_text().splitlines()
for line in lines:
    fields = line.split()
    if fields and not fields[0].startswith('#'):
        assert len(fields) > 1 and all(re.fullmatch(r'@[^/\\s]+/[^/\\s]+', owner) for owner in fields[1:]), line
print('Verified all CODEOWNERS entries reference teams')
PY`;
	const call = { ...event("bash", { command }), parentToolCallId: "codemode" };
	assert.equal(evaluateBashCall(call, { enabled: true, context }), undefined);
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
