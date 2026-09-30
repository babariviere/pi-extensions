import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { createActionTool, type ActionProvider } from "./action-tools.ts";

test("native action definitions return structured JSON and reject invalid prepared arguments", async () => {
	const provider: ActionProvider = {
		name: "example",
		description: "Example",
		list: async () => [],
		describe: async () => undefined,
		invoke: async (_action, args, ctx) => ({ value: args.value, cwd: ctx.cwd }),
	};
	const tool = createActionTool(provider, {
		name: "get",
		description: "Get data",
		inputSchema: Type.Object({ value: Type.Number() }) as unknown as Record<string, unknown>,
	});
	assert.equal(tool.name, "example_get");
	assert.equal(tool.exposure, "codemode");
	const result = await tool.execute("call", { value: 42 }, undefined, undefined, { cwd: "/workspace" } as never);
	assert.deepEqual(result.structuredContent, { value: 42, cwd: "/workspace" });
	await assert.rejects(
		tool.execute("call", { value: "no" }, undefined, undefined, { cwd: "/workspace" } as never),
		/Invalid arguments/,
	);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		tool.execute("call", { value: 1 }, controller.signal, undefined, { cwd: "/workspace" } as never),
	);
});
