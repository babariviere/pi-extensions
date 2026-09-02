import assert from "node:assert/strict";
import { test } from "node:test";

import type { McpServerStatus, McpToolSummary } from "./client-hub.ts";
import { formatMcpFooterStatus, formatMcpStatus, formatMcpTools, mcpFooterSummary } from "./status-report.ts";

const status = (overrides: Partial<McpServerStatus> = {}): McpServerStatus => ({
	name: "slack",
	state: "idle",
	transport: "http",
	target: "https://mcp.slack.com/mcp",
	...overrides,
});

test("no configured server points at mcp.json", () => {
	assert.match(formatMcpStatus([]), /Add one to ~\/\.pi\/agent\/mcp\.json/);
});

test("a status line carries state, tool count and target", () => {
	const text = formatMcpStatus([status({ state: "connected", tools: 12 })]);
	assert.match(text, /slack\s+connected\s+12 tools\s+https:\/\/mcp\.slack\.com\/mcp/);
});

test("a cached tool count says so", () => {
	assert.match(formatMcpStatus([status({ tools: 1, cached: true })]), /1 tool \(cached\)/);
});

test("a server needing auth gets the exact command to run", () => {
	const text = formatMcpStatus([status({ state: "needs-auth", detail: "not authorized" })]);
	assert.match(text, /needs auth/);
	assert.match(text, /Authorize with: \/mcp-auth slack/);
});

test("config problems are reported under the table", () => {
	const text = formatMcpStatus([status()], ["/repo/.pi/mcp.json: Unexpected token"]);
	assert.match(text, /Config problems:/);
	assert.match(text, /Unexpected token/);
});

test("an unsupported entry keeps its reason", () => {
	const text = formatMcpStatus([status({ state: "unsupported", detail: "socket transport is not implemented" })]);
	assert.match(text, /unsupported.*socket transport/s);
});

test("the footer summary counts only connectable servers", () => {
	const summary = mcpFooterSummary([
		status({ name: "slack", state: "connected" }),
		status({ name: "linear", state: "idle" }),
		status({ name: "old", state: "disabled" }),
		status({ name: "sock", state: "unsupported" }),
	]);
	assert.deepEqual(summary, { connected: 1, total: 2, needsAuth: 0, failed: 0 });
	assert.equal(formatMcpFooterStatus(summary!), "mcp 1/2");
});

test("no connectable server yields no footer item", () => {
	assert.equal(mcpFooterSummary([]), undefined);
	assert.equal(mcpFooterSummary([status({ state: "disabled" })]), undefined);
});

test("the footer flags servers needing auth and failures", () => {
	const summary = mcpFooterSummary([
		status({ name: "slack", state: "needs-auth" }),
		status({ name: "linear", state: "failed" }),
		status({ name: "local", state: "connected" }),
	]);
	assert.equal(formatMcpFooterStatus(summary!), "mcp 1/3 !auth \u27171");
});

test("tools group per server with their first description line", () => {
	const tools: McpToolSummary[] = [
		{
			server: "slack",
			name: "read_channel",
			prefixed: "mcp_slack_read_channel",
			description: "Read a channel\nmore",
		},
		{ server: "slack", name: "list_users", prefixed: "mcp_slack_list_users" },
	];
	const text = formatMcpTools(tools);
	assert.match(text, /slack \(2\)/);
	assert.match(text, /read_channel — Read a channel/);
	assert.equal(text.includes("more"), false);
});

test("an empty tool list names the connect command", () => {
	assert.match(formatMcpTools([], "linear"), /\/mcp connect linear/);
	assert.match(formatMcpTools([]), /\/mcp connect <server>/);
});
