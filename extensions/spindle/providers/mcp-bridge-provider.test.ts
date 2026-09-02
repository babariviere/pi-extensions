import assert from "node:assert/strict";
import { test } from "node:test";

import type { CapturedToolCatalog, CapturedToolEntry } from "../capture/catalog.ts";
import { DEFAULT_MCP_READ_ONLY_CONFIG, effectiveMcpReadOnlyConfig, McpReadOnlyGate } from "../mcp/read-only-policy.ts";
import { CapturedToolsProvider } from "./captured-tools-provider.ts";
import { McpBridgeProvider } from "./mcp-bridge-provider.ts";

const context = { nestedToolCallId: "spindle_1", signal: undefined, update: () => {} } as any;

const nightGate = (): McpReadOnlyGate =>
	McpReadOnlyGate.of(effectiveMcpReadOnlyConfig(DEFAULT_MCP_READ_ONLY_CONFIG, true));

interface GatewaySpy {
	calls: Array<Record<string, unknown>>;
	catalog: CapturedToolCatalog;
}

/** A catalog holding a single fake pi-mcp-adapter gateway tool. */
const gatewayCatalog = (name = "mcp"): GatewaySpy => {
	const calls: Array<Record<string, unknown>> = [];
	const entry = {
		name,
		definition: { name, description: "mcp gateway", parameters: { type: "object" } },
		sourceInfo: { path: "/npm/node_modules/pi-mcp-adapter/index.ts", source: "cli", scope: "user" },
		runner: {
			emit: async () => undefined,
			emitToolCall: async () => undefined,
			emitToolResult: async () => undefined,
		},
		wrappedTool: {
			execute: async (_id: string, params: Record<string, unknown>) => {
				calls.push(params);
				return { content: [{ type: "text", text: "ok" }] };
			},
		},
	} as unknown as CapturedToolEntry;
	const catalog = {
		list: () => [entry],
		get: (candidate: string) => (candidate === name ? entry : undefined),
		require: (candidate: string) => {
			if (candidate !== name) throw new Error(`Unknown captured extension tool: ${candidate}`);
			return entry;
		},
	} as unknown as CapturedToolCatalog;
	return { calls, catalog };
};

test("mcp.call refuses a write tool before the gateway is reached", async () => {
	const spy = gatewayCatalog();
	const provider = new McpBridgeProvider(() => spy.catalog, nightGate);
	for (const [server, tool] of [
		["slack", "slack_send_message"],
		["slack", "slack_add_reaction"],
		["linear", "save_comment"],
		["datadog", "update_datadog_monitor"],
	]) {
		await assert.rejects(
			() => provider.invoke("call", { server, tool, args: {} }, context),
			new RegExp(`MCP call ${server}\\.${tool} is refused`),
		);
	}
	assert.deepEqual(spy.calls, [], "a refused call must never reach the gateway");
});

test("mcp.call still forwards a read tool", async () => {
	const spy = gatewayCatalog();
	const provider = new McpBridgeProvider(() => spy.catalog, nightGate);
	await provider.invoke("call", { server: "linear", tool: "get_issue", args: { id: "ENG-1" } }, context);
	await provider.invoke("call", { server: "slack", tool: "slack_read_thread", args: {} }, context);
	assert.deepEqual(spy.calls, [
		{ tool: "get_issue", args: { id: "ENG-1" }, server: "linear" },
		{ tool: "slack_read_thread", args: {}, server: "slack" },
	]);
});

test("mcp management actions are never gated", async () => {
	const spy = gatewayCatalog();
	const provider = new McpBridgeProvider(() => spy.catalog, nightGate);
	await provider.invoke("search", { query: "message" }, context);
	await provider.invoke("describe", { tool: "slack_send_message" }, context);
	await provider.invoke("connect", { server: "slack" }, context);
	assert.equal(spy.calls.length, 3);
});

test("the same policy covers the gateway reached as extensions.mcp", async () => {
	const spy = gatewayCatalog();
	const provider = new CapturedToolsProvider(spy.catalog, nightGate);
	await assert.rejects(
		() => provider.invoke("mcp", { tool: "slack_send_message", server: "slack", args: {} }, context),
		/MCP call slack\.slack_send_message is refused/,
	);
	assert.deepEqual(spy.calls, []);
	await provider.invoke("mcp", { tool: "get_issue", server: "linear", args: {} }, context);
	assert.equal(spy.calls.length, 1);
});

test("a pi-mcp-adapter direct tool is gated by its own name", async () => {
	const writer = gatewayCatalog("slack_send_message");
	await assert.rejects(
		() => new CapturedToolsProvider(writer.catalog, nightGate).invoke("slack_send_message", {}, context),
		/MCP call slack\.slack_send_message is refused/,
	);
	assert.deepEqual(writer.calls, []);

	const reader = gatewayCatalog("slack_read_thread");
	await new CapturedToolsProvider(reader.catalog, nightGate).invoke("slack_read_thread", {}, context);
	assert.equal(reader.calls.length, 1);
});

test("mcp.<server>.<tool> refs route to the gateway instead of Unknown Spindle action", async () => {
	const spy = gatewayCatalog();
	const provider = new McpBridgeProvider(() => spy.catalog, nightGate);
	const descriptor = await provider.describe("slack.slack_read_channel", context);
	assert.equal(descriptor?.name, "slack.slack_read_channel");
	await provider.invoke("slack.slack_read_channel", { channel: "C1" }, context);
	assert.deepEqual(spy.calls, [{ tool: "slack_read_channel", args: { channel: "C1" }, server: "slack" }]);
	await assert.rejects(
		() => provider.invoke("slack.slack_send_message", { text: "hi" }, context),
		/MCP call slack\.slack_send_message is refused/,
	);
	assert.equal(spy.calls.length, 1, "a refused qualified call must never reach the gateway");
});

test("adapter-prefixed reads reach the gateway on the subagent path", async () => {
	const spy = gatewayCatalog();
	const provider = new McpBridgeProvider(() => spy.catalog, nightGate);
	await provider.invoke("call", { server: "slack", tool: "slack_slack_read_channel", args: {} }, context);
	await provider.invoke("call", { server: "datadog", tool: "datadog_search_datadog_logs", args: {} }, context);
	await provider.invoke("call", { server: "linear", tool: "linear_list_teams", args: {} }, context);
	assert.equal(spy.calls.length, 3);
	await assert.rejects(
		() => provider.invoke("call", { server: "slack", tool: "slack_slack_send_message", args: {} }, context),
		/is refused/,
	);
});

test("the mcp__<server> namespace proxy is gated like the gateway", async () => {
	const spy = gatewayCatalog("mcp__slack");
	const provider = new CapturedToolsProvider(spy.catalog, nightGate);
	await provider.invoke("mcp__slack", { tool: "slack_read_channel", args: {} }, context);
	assert.equal(spy.calls.length, 1);
	await assert.rejects(
		() => provider.invoke("mcp__slack", { tool: "slack_send_message", args: {} }, context),
		/MCP call slack\.slack_send_message is refused/,
	);
	assert.equal(spy.calls.length, 1);
});

test("repeated metadata reads hit the gateway once", async () => {
	const spy = gatewayCatalog();
	const provider = new McpBridgeProvider(() => spy.catalog);
	const cwdContext = { ...context, cwd: "/tmp" };
	await provider.invoke("list", {}, cwdContext);
	await provider.invoke("list", {}, cwdContext);
	assert.equal(spy.calls.length, 1);
});

test("a tool call is never served from the descriptor cache", async () => {
	const spy = gatewayCatalog();
	const provider = new McpBridgeProvider(() => spy.catalog);
	const cwdContext = { ...context, cwd: "/tmp" };
	await provider.invoke("call", { server: "s", tool: "read_thing", args: {} }, cwdContext);
	await provider.invoke("call", { server: "s", tool: "read_thing", args: {} }, cwdContext);
	assert.equal(spy.calls.length, 2);
});

test("a connect invalidates cached metadata reads", async () => {
	const spy = gatewayCatalog();
	const provider = new McpBridgeProvider(() => spy.catalog);
	const cwdContext = { ...context, cwd: "/tmp" };
	await provider.invoke("list", {}, cwdContext);
	await provider.invoke("connect", { server: "s" }, cwdContext);
	await provider.invoke("list", {}, cwdContext);
	assert.equal(spy.calls.filter((call) => call.connect === undefined).length, 2);
});
