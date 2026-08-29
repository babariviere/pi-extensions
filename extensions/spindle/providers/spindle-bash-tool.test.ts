import assert from "node:assert/strict";
import { test } from "node:test";

import { createSpindleBashToolDefinition, MAX_STDIN_CHARS } from "./spindle-bash-tool.ts";

const text = (result: { content: Array<{ type: string; text?: string }> }): string =>
	result.content
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");

const fakeOps = (seen: Array<{ command: string; cwd: string; env?: Record<string, string | undefined> }>) => ({
	exec: async (
		command: string,
		cwd: string,
		options: { onData: (data: Buffer) => void; env?: Record<string, string | undefined> },
	) => {
		seen.push({ command, cwd, env: options.env });
		options.onData(Buffer.from("ok"));
		return { exitCode: 0 };
	},
});

test("extras-free calls run unchanged on the base tool", async () => {
	const seen: Array<{ command: string; cwd: string; env?: Record<string, string | undefined> }> = [];
	const tool = createSpindleBashToolDefinition(process.cwd(), {
		operations: fakeOps(seen),
	});
	const result = await tool.execute("t1", { command: "ls" }, undefined, undefined, undefined as never);
	assert.equal(text(result), "ok");
	assert.equal(seen.length, 1);
	assert.equal(seen[0].cwd, process.cwd());
});

test("cwd and env extras are applied and merged over the shell env", async () => {
	const seen: Array<{ command: string; cwd: string; env?: Record<string, string | undefined> }> = [];
	const tool = createSpindleBashToolDefinition(process.cwd(), {
		operations: fakeOps(seen),
	});
	await tool.execute(
		"t2",
		{ command: "pwd", cwd: "/tmp", env: { SPINDLE_TEST_VAR: "1" } },
		undefined,
		undefined,
		undefined as never,
	);
	assert.equal(seen.length, 1);
	assert.equal(seen[0].cwd, "/tmp");
	assert.equal(seen[0].env?.SPINDLE_TEST_VAR, "1");
	// merged, not replaced: the shell environment survives
	assert.ok(typeof seen[0].env?.PATH === "string" || "PATH" in (seen[0].env ?? {}));
});

test("stdin is piped to the command", async () => {
	const tool = createSpindleBashToolDefinition(process.cwd(), {});
	const result = await tool.execute(
		"t3",
		{ command: "cat", stdin: "hello\nstdin" },
		undefined,
		undefined,
		undefined as never,
	);
	assert.equal(text(result).trim(), "hello\nstdin");
});

test("stdin, cwd, and env combine", async () => {
	const tool = createSpindleBashToolDefinition(process.cwd(), {});
	const result = await tool.execute(
		"t4",
		{ command: "cat; pwd", cwd: "/tmp", env: { SPINDLE_TEST_VAR: "1" }, stdin: "x\n" },
		undefined,
		undefined,
		undefined as never,
	);
	assert.match(text(result), /^x\n\/tmp/);
});

test("rejects a cwd that is not an existing directory", async () => {
	const tool = createSpindleBashToolDefinition(process.cwd(), {});
	await assert.rejects(
		() =>
			tool.execute("t5", { command: "ls", cwd: "/definitely/not/a/dir" }, undefined, undefined, undefined as never),
		/not an existing directory/,
	);
});

test("rejects a relative cwd", async () => {
	const tool = createSpindleBashToolDefinition(process.cwd(), {});
	await assert.rejects(
		() => tool.execute("t6", { command: "ls", cwd: "relative/dir" }, undefined, undefined, undefined as never),
		/must be an absolute path/,
	);
});

test("rejects stdin above the size cap", async () => {
	const tool = createSpindleBashToolDefinition(process.cwd(), {});
	await assert.rejects(
		() =>
			tool.execute(
				"t7",
				{ command: "cat", stdin: "x".repeat(MAX_STDIN_CHARS + 1) },
				undefined,
				undefined,
				undefined as never,
			),
		/the limit is/,
	);
});
