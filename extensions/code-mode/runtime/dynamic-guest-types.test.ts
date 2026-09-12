import assert from "node:assert/strict";
import { test } from "node:test";

import { buildDynamicGuestDeclarations } from "./dynamic-guest-types.ts";
import { guestTypeDeclarations } from "./guest-types.ts";
import { typeCheckCodeModeCode } from "./type-checker.ts";

const searchTool = {
	name: "web_search",
	inputSchema: {
		type: "object",
		properties: { query: { type: "string" }, limit: { type: "number" } },
		required: ["query"],
		additionalProperties: false,
	},
};

test("an empty source set keeps the loose declarations", () => {
	assert.deepEqual(buildDynamicGuestDeclarations({}), {});
});

test("captured sibling tools do not create a guest namespace", () => {
	const dynamic = buildDynamicGuestDeclarations({});
	assert.deepEqual(dynamic, {});
});

test("explicit web tools are not represented by the removed dynamic fallback", () => {
	const declarations = guestTypeDeclarations(true, buildDynamicGuestDeclarations({}));
	assert.equal(declarations.includes("declare const extensions"), false);
	const outcome = typeCheckCodeModeCode("return await web.search({ query: 'x' });", declarations);
	assert.deepEqual(outcome.errors, []);
});

const readChannel = {
	name: "read_channel",
	inputSchema: {
		type: "object",
		properties: { channel: { type: "string" }, limit: { type: "number" } },
		required: ["channel"],
		additionalProperties: false,
	},
};

test("cached MCP tools render into a per-server tool map", () => {
	const dynamic = buildDynamicGuestDeclarations({ mcpServers: [{ server: "slack", tools: [readChannel] }] });
	assert.match(String(dynamic.mcp), /interface CodeModeMcpToolMap \{/);
	assert.match(String(dynamic.mcp), /read_channel: \{ channel: string; limit\?: number \};/);
	assert.match(String(dynamic.mcp), /declare const mcp: CodeModeMcpApiDynamic;/);
	// Index signatures at both levels keep an uncached tool and a computed server
	// callable rather than turning them into type errors.
	assert.match(String(dynamic.mcp), /\[tool: string\]: Record<string, unknown>;/);
	assert.match(String(dynamic.mcp), /\[server: string\]: Record<string, Record<string, unknown>>;/);
});

test("no cached MCP server leaves the loose mcp declaration alone", () => {
	assert.equal(buildDynamicGuestDeclarations({ mcpServers: [] }).mcp, undefined);
	assert.equal(buildDynamicGuestDeclarations({ mcpServers: [{ server: "slack", tools: [] }] }).mcp, undefined);
});

test("the generated mcp surface type-checks a good call and rejects a bad one", () => {
	const declarations = guestTypeDeclarations(
		true,
		buildDynamicGuestDeclarations({ mcpServers: [{ server: "slack", tools: [readChannel] }] }),
	);
	assert.equal(declarations.includes("declare const mcp: CodeModeMcpApi;\n"), false);

	const good = typeCheckCodeModeCode(
		"return await mcp.call('slack', 'read_channel', { channel: 'c' });",
		declarations,
	);
	assert.deepEqual(good.errors, []);

	const bad = typeCheckCodeModeCode("return await mcp.call('slack', 'read_channel', { chanel: 'c' });", declarations);
	assert.ok(bad.errors.length > 0);
	assert.match(bad.errors[0]!.message, /chanel/);

	// Deliberately NOT caught here: `CodeModeMcpToolMap[S][T]` is a generic indexed
	// access, so TypeScript runs excess-property checking against it but defers
	// assignability. A wrong argument type and a missing required argument both
	// reach dispatch, where the server's schema validation refuses them. These
	// assertions pin that boundary so a future change to the surface is noticed.
	const wrongType = typeCheckCodeModeCode(
		"return await mcp.call('slack', 'read_channel', { channel: 1 });",
		declarations,
	);
	assert.deepEqual(wrongType.errors, []);
	const missing = typeCheckCodeModeCode("return await mcp.call('slack', 'read_channel', {});", declarations);
	assert.deepEqual(missing.errors, []);
});

test("an uncached tool on a cached server falls through to the loose overload", () => {
	const declarations = guestTypeDeclarations(
		true,
		buildDynamicGuestDeclarations({ mcpServers: [{ server: "slack", tools: [readChannel] }] }),
	);
	const outcome = typeCheckCodeModeCode(
		"return await mcp.call('slack', 'not_listed_yet', { anything: 1 });",
		declarations,
	);
	assert.deepEqual(outcome.errors, []);
});

const todoRecordSchema = {
	type: "object",
	properties: { id: { type: "string" }, title: { type: "string" }, body: { type: "string" } },
	required: ["id", "title", "body"],
	additionalProperties: false,
};

const todoProvider = {
	name: "todo",
	actions: [
		{
			name: "list",
			inputSchema: { type: "object", properties: {}, additionalProperties: false },
			outputSchema: { type: "array", items: todoRecordSchema },
		},
		{
			name: "listAll",
			inputSchema: { type: "object", properties: {}, additionalProperties: false },
			outputSchema: { type: "array", items: todoRecordSchema },
		},
		{
			name: "create",
			inputSchema: {
				type: "object",
				properties: { title: { type: "string" }, body: { type: "string" } },
				required: ["title"],
				additionalProperties: false,
			},
			outputSchema: todoRecordSchema,
		},
	],
};

test("custom provider descriptors render exact methods, inputs, and outputs", () => {
	const dynamic = buildDynamicGuestDeclarations({ providers: [todoProvider] });
	const declarations = guestTypeDeclarations(true, dynamic, ["todo"]);
	assert.match(String(dynamic.providers?.todo), /interface CodeModeProviderApi_todo/);
	assert.doesNotMatch(
		declarations,
		/declare const todo: Record<string, \(args\?: Record<string, unknown>\) => Promise<unknown>>/,
	);

	const good = typeCheckCodeModeCode(
		"const open = await todo.list(); const all = await todo.listAll(); const created = await todo.create({ title: 'x' }); const title: string = created.title; return { open, all, title };",
		declarations,
	);
	assert.deepEqual(good.errors, []);

	for (const code of [
		"return await todo.create({});",
		"return await todo.create({ title: 'x', unknown: true });",
		"return await todo.list({ unknown: true });",
		"return await todo.notAnAction();",
	]) {
		assert.ok(typeCheckCodeModeCode(code, declarations).errors.length > 0, code);
	}
});

test("night.plan receives an exact nested task declaration", () => {
	const dynamic = buildDynamicGuestDeclarations({
		providers: [
			{
				name: "night",
				actions: [
					{
						name: "plan",
						inputSchema: {
							type: "object",
							properties: {
								tasks: {
									type: "array",
									items: {
										type: "object",
										properties: {
											title: { type: "string" },
											goal: { type: "string" },
											repository: { type: "string" },
											definitionOfDone: { type: "string" },
										},
										required: ["title", "goal", "repository", "definitionOfDone"],
									},
								},
							},
							required: ["tasks"],
						},
						outputSchema: {
							type: "object",
							properties: { status: { enum: ["approved", "dismissed"] }, message: { type: "string" } },
							required: ["status", "message"],
						},
					},
				],
			},
		],
	});
	const declarations = guestTypeDeclarations(false, dynamic, ["night"]);
	const task = "{ title: 'docs', goal: 'update', repository: '/repo', definitionOfDone: 'tests pass' }";
	assert.deepEqual(typeCheckCodeModeCode(`return await night.plan({ tasks: [${task}] });`, declarations).errors, []);
	assert.ok(
		typeCheckCodeModeCode("return await night.plan({ tasks: [{ title: 'docs' }] });", declarations).errors.length > 0,
	);
	assert.ok(
		typeCheckCodeModeCode(`return await night.plan({ tasks: [{ ...${task}, surprise: true }] });`, declarations)
			.errors.length > 0,
	);
});

test("a provider without listed descriptors keeps the loose fallback", () => {
	const declarations = guestTypeDeclarations(true, buildDynamicGuestDeclarations({}), ["todo"]);
	assert.match(
		declarations,
		/declare const todo: Record<string, \(args\?: Record<string, unknown>\) => Promise<unknown>>/,
	);
	assert.deepEqual(typeCheckCodeModeCode("return await todo.notListedYet({ anything: 1 });", declarations).errors, []);
});
