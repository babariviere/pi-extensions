import assert from "node:assert/strict";
import { test } from "node:test";

import { McpClientHub } from "./client-hub.ts";
import type { McpServerConfig, McpServerDefinition } from "./server-config.ts";
import { McpToolCache } from "./tool-cache.ts";

const datadog: McpServerDefinition = {
	name: "datadog",
	transport: "http",
	url: "https://mcp.datadoghq.eu/v1/mcp",
	excludeTools: ["get_datadog_dbm_*"],
	disabled: false,
	sources: [],
};

const cacheWith = () => {
	const files = new Map<string, string>();
	return new McpToolCache({
		filePath: "/cache.json",
		readFile: (filePath) => {
			const contents = files.get(filePath);
			if (contents === undefined) throw new Error("ENOENT");
			return contents;
		},
		writeFile: (filePath, contents) => void files.set(filePath, contents),
	});
};

const hubWithCachedDatadogTools = () => {
	const cache = cacheWith();
	cache.set("datadog", String(datadog.url), "test", [
		{ name: "get_datadog_dbm_postgresql" },
		{ name: "search_datadog_logs" },
	]);
	return new McpClientHub({
		cwd: "/repo",
		cache,
		fingerprint: () => "test",
		loadConfig: (): McpServerConfig => ({ servers: [datadog], layers: [], errors: [] }),
	});
};

test("an excluded Datadog database tool is neither discoverable nor callable from a stale cache", async () => {
	const hub = hubWithCachedDatadogTools();

	assert.deepEqual(await hub.listTools("datadog"), [
		{
			server: "datadog",
			name: "search_datadog_logs",
			prefixed: "mcp_datadog_search_datadog_logs",
		},
	]);
	assert.deepEqual(await hub.searchTools("dbm", { server: "datadog" }), []);
	await assert.rejects(
		() => hub.callTool("get_datadog_dbm_postgresql", {}, {}, "datadog"),
		/filtered out.*excludeTools/,
	);
});
