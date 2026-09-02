import assert from "node:assert/strict";
import { test } from "node:test";

import type { CallToolResult } from "@modelcontextprotocol/client";
import type { McpServerStatus, McpToolDescription, McpToolHub, McpToolSummary } from "../mcp/client-hub.ts";
import { McpReadOnlyGate } from "../mcp/read-only-policy.ts";
import type { SpindleInvocationContext } from "../protocol.ts";
import { McpClientProvider } from "./mcp-client-provider.ts";

const context = {
	cwd: "/repo",
	signal: undefined,
	parentToolCallId: "parent",
	nestedToolCallId: "nested",
	extensionContext: {} as SpindleInvocationContext["extensionContext"],
	update: () => {},
} satisfies SpindleInvocationContext;

const tool = (server: string, name: string): McpToolDescription => ({
	server,
	name,
	prefixed: `mcp_${server}_${name}`,
	inputSchema: { type: "object", properties: { channel: { type: "string" } }, required: ["channel"] },
	description: `${name} on ${server}`,
});

const fakeHub = (overrides: Partial<McpToolHub> = {}) => {
	const calls: { tool: string; args: Record<string, unknown>; server?: string }[] = [];
	const hub: McpToolHub = {
		status: (server?: string): McpServerStatus[] =>
			(
				[
					{ name: "slack", state: "idle", transport: "http", target: "https://mcp.slack.com/mcp" },
				] as McpServerStatus[]
			).filter((entry) => server === undefined || entry.name === server),
		listTools: async (): Promise<McpToolSummary[]> => [tool("slack", "read_channel")],
		describeTool: async (ref: string) => (ref.includes("read") ? tool("slack", "read_channel") : undefined),
		searchTools: async () => [tool("slack", "read_channel")],
		cachedTools: async () => [tool("slack", "read_channel")],
		connect: async (server: string) => ({
			name: server,
			state: "connected" as const,
			transport: "http" as const,
			tools: 1,
		}),
		callTool: async (toolName, args, _ctx, server) => {
			calls.push({ tool: toolName, args, ...(server ? { server } : {}) });
			return { content: [{ type: "text", text: "ok" }] } as CallToolResult;
		},
		close: async () => {},
		...overrides,
	};
	return { hub, calls };
};

const providerWith = (overrides: Partial<McpToolHub> = {}, gate = McpReadOnlyGate.unrestricted()) => {
	const { hub, calls } = fakeHub(overrides);
	return {
		provider: new McpClientProvider(
			() => hub,
			() => gate,
		),
		calls,
	};
};

test("list returns static descriptors and never touches the hub", async () => {
	const { provider } = providerWith({
		listTools: async () => {
			throw new Error("listTools must not be called by list()");
		},
	});
	const listed = await provider.list({}, context);
	assert.deepEqual(listed.map((descriptor) => descriptor.name).sort(), [
		"call",
		"connect",
		"describe",
		"list",
		"search",
	]);
});

test("a qualified action is described with the server's real input schema", async () => {
	const { provider } = providerWith();
	const descriptor = await provider.describe("slack.read_channel", context);
	assert.deepEqual(descriptor?.inputSchema, tool("slack", "read_channel").inputSchema);
	assert.equal(descriptor?.namespace, "mcp:slack");
});

test("an unlisted tool still gets a permissive stub descriptor", async () => {
	const { provider } = providerWith();
	const descriptor = await provider.describe("slack.unknown_tool", context);
	assert.deepEqual(descriptor?.inputSchema, { type: "object", additionalProperties: true });
});

test("mcp.call forwards to the hub and normalizes the result", async () => {
	const { provider, calls } = providerWith();
	const result = await provider.invoke(
		"call",
		{ server: "slack", tool: "read_channel", args: { channel: "c" } },
		context,
	);
	assert.deepEqual(calls, [{ tool: "read_channel", args: { channel: "c" }, server: "slack" }]);
	assert.deepEqual(result, { text: "ok", content: [{ type: "text", text: "ok" }], structuredContent: null });
});

test("mcp.<server>.<tool> sugar reaches the same path", async () => {
	const { provider, calls } = providerWith();
	await provider.invoke("slack.read_channel", { channel: "c" }, context);
	assert.deepEqual(calls, [{ tool: "read_channel", args: { channel: "c" }, server: "slack" }]);
});

test("an isError result rejects instead of returning silently", async () => {
	const { provider } = providerWith({
		callTool: async () => ({ content: [{ type: "text", text: "boom" }], isError: true }) as CallToolResult,
	});
	await assert.rejects(() => provider.invoke("call", { tool: "read_channel" }, context), /boom/);
});

test("a write tool is refused before the hub is reached", async () => {
	const gate = McpReadOnlyGate.of({
		readOnly: true,
		unknownToolPolicy: "deny",
		defaultServerPolicy: "deny-writes",
		servers: {},
	});
	const { provider, calls } = providerWith({}, gate);
	await assert.rejects(() => provider.invoke("call", { server: "slack", tool: "send_message" }, context));
	assert.deepEqual(calls, []);
});

test("search drops schemas unless they are asked for", async () => {
	const { provider } = providerWith();
	const lean = (await provider.invoke("search", { query: "read" }, context)) as { tools: Record<string, unknown>[] };
	assert.equal("inputSchema" in (lean.tools[0] ?? {}), false);
	const full = (await provider.invoke("search", { query: "read", includeSchemas: true }, context)) as {
		tools: Record<string, unknown>[];
	};
	assert.equal("inputSchema" in (full.tools[0] ?? {}), true);
});

test("describe rejects an unknown tool with an actionable error", async () => {
	const { provider } = providerWith();
	await assert.rejects(() => provider.invoke("describe", { tool: "nope" }, context), /Unknown MCP tool/);
});

test("list reports server status without connecting", async () => {
	const { provider } = providerWith();
	const listed = (await provider.invoke("list", {}, context)) as { servers: McpServerStatus[] };
	assert.deepEqual(listed.servers[0]?.name, "slack");
	assert.deepEqual(listed.servers[0]?.state, "idle");
});

test("an unknown action is rejected by name", async () => {
	const { provider } = providerWith();
	await assert.rejects(() => provider.invoke("nonsense", {}, context), /Unknown mcp action/);
});

test("cached tool schemas are grouped per server for the guest type surface", async () => {
	const { provider } = providerWith();
	const sources = await provider.mcpGuestTypeSources(context);
	assert.deepEqual(sources, [
		{ server: "slack", tools: [{ name: "read_channel", inputSchema: tool("slack", "read_channel").inputSchema }] },
	]);
});
