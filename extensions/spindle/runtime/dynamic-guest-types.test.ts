import assert from "node:assert/strict";
import { test } from "node:test";

import { buildDynamicGuestDeclarations } from "./dynamic-guest-types.ts";
import { guestTypeDeclarations } from "./guest-types.ts";
import { typeCheckSpindleCode } from "./type-checker.ts";

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
	assert.deepEqual(buildDynamicGuestDeclarations({ extensionTools: [] }), {});
});

test("extension tools render with their declared schemas", () => {
	const dynamic = buildDynamicGuestDeclarations({ extensionTools: [searchTool] });
	assert.match(String(dynamic.extensions), /web_search\(args: \{ limit\?: number; query: string \}\)/);
	assert.match(String(dynamic.extensions), /declare const extensions: SpindleExtensionsApiDynamic;/);
});

test("non-identifier tool names render as quoted members", () => {
	const dynamic = buildDynamicGuestDeclarations({
		extensionTools: [{ name: "linear-issue", inputSchema: { type: "object", properties: {} } }],
	});
	assert.match(String(dynamic.extensions), /"linear-issue"\(args\?:/);
});

test("the generated surface replaces the loose declaration and gates bad arguments", () => {
	const declarations = guestTypeDeclarations(
		true,
		buildDynamicGuestDeclarations({
			extensionTools: [searchTool],
		}),
	);
	assert.equal(declarations.includes("declare const extensions: SpindleExtensionsApi;\n"), false);

	const good = typeCheckSpindleCode("return await extensions.web_search({ query: 'x' });", declarations);
	assert.deepEqual(good.errors, []);

	const bad = typeCheckSpindleCode("return await extensions.web_search({ quer: 'x' });", declarations);
	assert.ok(bad.errors.length > 0);
	assert.match(bad.errors[0]!.message, /quer/);
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
	assert.match(String(dynamic.mcp), /interface SpindleMcpToolMap \{/);
	assert.match(String(dynamic.mcp), /read_channel: \{ channel: string; limit\?: number \};/);
	assert.match(String(dynamic.mcp), /declare const mcp: SpindleMcpApiDynamic;/);
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
	assert.equal(declarations.includes("declare const mcp: SpindleMcpApi;\n"), false);

	const good = typeCheckSpindleCode("return await mcp.call('slack', 'read_channel', { channel: 'c' });", declarations);
	assert.deepEqual(good.errors, []);

	const bad = typeCheckSpindleCode("return await mcp.call('slack', 'read_channel', { chanel: 'c' });", declarations);
	assert.ok(bad.errors.length > 0);
	assert.match(bad.errors[0]!.message, /chanel/);

	// Deliberately NOT caught here: `SpindleMcpToolMap[S][T]` is a generic indexed
	// access, so TypeScript runs excess-property checking against it but defers
	// assignability. A wrong argument type and a missing required argument both
	// reach dispatch, where the server's schema validation refuses them. These
	// assertions pin that boundary so a future change to the surface is noticed.
	const wrongType = typeCheckSpindleCode(
		"return await mcp.call('slack', 'read_channel', { channel: 1 });",
		declarations,
	);
	assert.deepEqual(wrongType.errors, []);
	const missing = typeCheckSpindleCode("return await mcp.call('slack', 'read_channel', {});", declarations);
	assert.deepEqual(missing.errors, []);
});

test("an uncached tool on a cached server falls through to the loose overload", () => {
	const declarations = guestTypeDeclarations(
		true,
		buildDynamicGuestDeclarations({ mcpServers: [{ server: "slack", tools: [readChannel] }] }),
	);
	const outcome = typeCheckSpindleCode(
		"return await mcp.call('slack', 'not_listed_yet', { anything: 1 });",
		declarations,
	);
	assert.deepEqual(outcome.errors, []);
});
