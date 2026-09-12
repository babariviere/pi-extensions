import assert from "node:assert/strict";
import { test } from "node:test";
import { ActionRegistry } from "./action-registry.ts";
import type { CodeModeInvocationContext, CodeModeProvider } from "../protocol.ts";

const provider = (name: string): CodeModeProvider => ({
	name,
	description: name,
	list: async () => [],
	describe: async () => undefined,
	invoke: async () => null,
});

test("registration cannot restore the removed namespace or overwrite guest helpers", () => {
	const registry = new ActionRegistry();
	for (const name of ["extensions", "tools", "process", "console", "print"]) {
		assert.throws(() => registry.register(provider(name)), /Invalid Code Mode provider name/);
		assert.equal(registry.has(name), false);
	}
	registry.register(provider("reports"));
	assert.equal(registry.has("reports"), true);
});

test("registration rejects provider names that are not JavaScript identifiers", () => {
	const registry = new ActionRegistry();
	for (const name of ["my-provider", "1provider", "provider.name"]) {
		assert.throws(() => registry.register(provider(name)), /Invalid Code Mode provider name/);
	}
});

const invocationContext = {
	cwd: "/tmp",
	signal: undefined,
	parentToolCallId: "test",
	nestedToolCallId: "test_types",
	extensionContext: {} as never,
	update: () => {},
} satisfies CodeModeInvocationContext;

test("guest type sources include listed custom provider input and output schemas", async () => {
	const registry = new ActionRegistry();
	registry.register({
		...provider("todo"),
		list: async () => [
			{
				name: "create",
				description: "create",
				inputSchema: {
					type: "object",
					properties: { title: { type: "string" } },
					required: ["title"],
					additionalProperties: false,
				},
				outputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
			},
		],
	});
	registry.register({ ...provider("broken"), list: async () => Promise.reject(new Error("listing failed")) });
	registry.register(provider("web"));

	assert.deepEqual(await registry.guestTypeSources(invocationContext), {
		providers: [
			{
				name: "todo",
				actions: [
					{
						name: "create",
						inputSchema: {
							type: "object",
							properties: { title: { type: "string" } },
							required: ["title"],
							additionalProperties: false,
						},
						outputSchema: {
							type: "object",
							properties: { id: { type: "string" } },
							required: ["id"],
						},
					},
				],
			},
		],
	});
});
