import assert from "node:assert/strict";
import { test } from "node:test";

import { McpToolCache } from "./tool-cache.ts";

const cacheWith = (initial?: string) => {
	const files = new Map<string, string>();
	if (initial !== undefined) files.set("/cache.json", initial);
	const cache = new McpToolCache({
		filePath: "/cache.json",
		readFile: (filePath) => {
			const value = files.get(filePath);
			if (value === undefined) throw new Error("ENOENT");
			return value;
		},
		writeFile: (filePath, contents) => void files.set(filePath, contents),
		now: () => 42,
	});
	return { cache, files };
};

test("tools survive a round trip through the file", () => {
	const { cache, files } = cacheWith();
	cache.set("slack", "https://mcp.slack.com/mcp", "fp", [{ name: "read_channel", inputSchema: { type: "object" } }]);
	const reloaded = new McpToolCache({
		filePath: "/cache.json",
		readFile: (filePath) => String(files.get(filePath)),
		writeFile: () => {},
	});
	assert.deepEqual(reloaded.get("slack", "https://mcp.slack.com/mcp", "fp")?.tools, [
		{ name: "read_channel", inputSchema: { type: "object" } },
	]);
});

test("a different endpoint invalidates the entry", () => {
	const { cache } = cacheWith();
	cache.set("slack", "https://mcp.slack.com/mcp", "fp", [{ name: "read_channel" }]);
	assert.equal(cache.get("slack", "https://elsewhere/mcp", "fp"), undefined);
});

test("a changed config fingerprint invalidates the entry", () => {
	const { cache } = cacheWith();
	cache.set("slack", "https://mcp.slack.com/mcp", "fp", [{ name: "read_channel" }]);
	assert.equal(cache.get("slack", "https://mcp.slack.com/mcp", "other"), undefined);
});

test("a corrupt cache file reads as empty", () => {
	const { cache } = cacheWith("{ not json");
	assert.deepEqual(cache.entries(), []);
});

test("an unwritable cache does not throw", () => {
	const cache = new McpToolCache({
		filePath: "/cache.json",
		readFile: () => {
			throw new Error("ENOENT");
		},
		writeFile: () => {
			throw new Error("EROFS");
		},
	});
	assert.doesNotThrow(() => cache.set("slack", "url", "fp", []));
});

test("delete drops the entry", () => {
	const { cache } = cacheWith();
	cache.set("slack", "url", "fp", [{ name: "a" }]);
	cache.delete("slack");
	assert.deepEqual(cache.entries(), []);
});
