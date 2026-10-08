import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { createActionsTool, type ActionProvider } from "./action-tools.ts";
import { Value } from "typebox/value";

test("native action definitions return structured JSON and reject invalid prepared arguments", async () => {
	const provider: ActionProvider = {
		name: "example",
		description: "Example",
		instructions: "Longer example workflow.",
		list: async () => [],
		describe: async () => undefined,
		invoke: async (_action, args, ctx) => ({ value: args.value, cwd: ctx.cwd }),
	};
	const tool = createActionsTool(provider, [
		{
			name: "get",
			description: "Get data",
			inputSchema: Type.Object({ value: Type.Number() }) as unknown as Record<string, unknown>,
		},
	]);
	assert.equal(tool.name, "example");
	assert.equal(tool.exposure, "codemode");
	assert.deepEqual(tool.namespace, {
		name: "example",
		description: "Example",
		instructions: "Longer example workflow.",
	});
	const result = await tool.execute("call", { action: "get", value: 42 }, undefined, undefined, {
		cwd: "/workspace",
	} as never);
	assert.deepEqual(result.structuredContent, { value: 42, cwd: "/workspace" });
	await assert.rejects(
		tool.execute("call", { action: "get", value: "no" }, undefined, undefined, { cwd: "/workspace" } as never),
		/Invalid arguments/,
	);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		tool.execute("call", { action: "get", value: 1 }, controller.signal, undefined, { cwd: "/workspace" } as never),
	);
});

test("one action tool dispatches, validates per-action arguments, and aggregates hints", async () => {
	const calls: unknown[] = [];
	const provider: ActionProvider = {
		name: "example",
		description: "Example actions",
		list: async () => [],
		describe: async () => undefined,
		prepareArguments: (action, args) => {
			calls.push({ prepared: action, args });
			return args;
		},
		invoke: async (action, args, ctx) => {
			calls.push({ invoked: action, args, id: ctx.parentToolCallId });
			ctx.update("progress");
			return action === "list" ? [] : { value: args.value };
		},
	};
	const tool = createActionsTool(provider, [
		{
			name: "list",
			description: "List values",
			inputSchema: { type: "object", properties: {}, additionalProperties: false },
			outputSchema: { type: "array", items: { type: "number" } },
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		{
			name: "set",
			description: "Set a value",
			inputSchema: {
				type: "object",
				properties: { value: { type: "number" } },
				required: ["value"],
				additionalProperties: false,
			},
			outputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"] },
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
	]);
	assert.equal(tool.name, "example");
	assert.equal(tool.exposure, "codemode");
	assert.deepEqual(tool.annotations, {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: false,
	});
	assert.ok(Value.Check(tool.parameters, { action: "set", value: 42 }));
	assert.ok(!Value.Check(tool.parameters, {}));
	assert.ok(!Value.Check(tool.parameters, { action: "unknown" }));
	const updates: unknown[] = [];
	const result = await tool.execute(
		"call",
		{ action: "set", value: 42 },
		undefined,
		(update) => updates.push(update),
		{ cwd: "/workspace" } as never,
	);
	assert.deepEqual(result.structuredContent, { value: 42 });
	assert.ok(Value.Check(tool.outputSchema!, result.structuredContent));
	assert.equal(updates.length, 1);
	assert.deepEqual(calls, [
		{ prepared: "set", args: { value: 42 } },
		{ invoked: "set", args: { value: 42 }, id: "call" },
	]);
	const list = await tool.execute("list", { action: "list" }, undefined, undefined, {} as never);
	assert.deepEqual(list.structuredContent, []);
	assert.ok(Value.Check(tool.outputSchema!, list.structuredContent));
	for (const args of [
		{ action: "set" },
		{ action: "set", value: "no" },
		{ action: "list", value: 42 },
		{ action: "set", value: 42, extra: true },
	])
		await assert.rejects(tool.execute("bad", args, undefined, undefined, {} as never), /Invalid arguments/);
	for (const args of [{}, { action: "unknown" }])
		await assert.rejects(tool.execute("bad", args, undefined, undefined, {} as never), /Unknown example action/);
	await assert.rejects(
		tool.execute(
			"abort",
			{ action: "set", value: 42 },
			AbortSignal.abort(new Error("cancelled")),
			undefined,
			{} as never,
		),
		/cancelled/,
	);
	assert.throws(() => createActionsTool(provider, []), /at least one action/);
});
