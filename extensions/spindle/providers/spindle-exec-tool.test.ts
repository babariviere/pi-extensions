import assert from "node:assert/strict";
import { test } from "node:test";
import { createSpindleExecToolDefinition } from "./spindle-exec-tool.ts";

const text = (result: { content: Array<{ type: string; text?: string }> }): string =>
	result.content
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");

test("exec passes each argv entry literally without shell parsing", async () => {
	const value = `spaces ' quotes " and $dollar; semicolon`;
	const tool = createSpindleExecToolDefinition(process.cwd());
	const result = await tool.execute(
		"exec-1",
		{ argv: [process.execPath, "-e", "process.stdout.write(process.argv[1])", value] },
		undefined,
		undefined,
		undefined as never,
	);
	assert.equal(text(result), value);
});

test("exec pipes stdin without requiring a shell", async () => {
	const tool = createSpindleExecToolDefinition(process.cwd());
	const result = await tool.execute(
		"exec-2",
		{ argv: [process.execPath, "-e", "process.stdin.pipe(process.stdout)"], stdin: "hello\nstdin" },
		undefined,
		undefined,
		undefined as never,
	);
	assert.equal(text(result), "hello\nstdin");
});
