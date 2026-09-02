import assert from "node:assert/strict";
import { test } from "node:test";

import { McpDescriptorCache } from "./descriptor-cache.ts";

const cacheWith = (state: { now: number; fingerprint: string }) =>
	new McpDescriptorCache(
		1_000,
		() => state.now,
		() => state.fingerprint,
	);

test("a metadata read is served from the cache", () => {
	const state = { now: 0, fingerprint: "a" };
	const cache = cacheWith(state);
	cache.set("list", {}, "/cwd", { servers: [] });
	assert.deepEqual(cache.get("list", {}, "/cwd"), { value: { servers: [] } });
});

test("tool calls are never cached", () => {
	const cache = cacheWith({ now: 0, fingerprint: "a" });
	cache.set("call", { tool: "x" }, "/cwd", "result");
	assert.equal(cache.get("call", { tool: "x" }, "/cwd"), undefined);
	assert.equal(cache.size, 0);
});

test("an expired entry is dropped", () => {
	const state = { now: 0, fingerprint: "a" };
	const cache = cacheWith(state);
	cache.set("describe", { tool: "x" }, "/cwd", "described");
	state.now = 5_000;
	assert.equal(cache.get("describe", { tool: "x" }, "/cwd"), undefined);
});

test("a changed config fingerprint invalidates the entry", () => {
	const state = { now: 0, fingerprint: "a" };
	const cache = cacheWith(state);
	cache.set("list", {}, "/cwd", "listed");
	state.fingerprint = "b";
	assert.equal(cache.get("list", {}, "/cwd"), undefined);
});

test("argument order does not change the key", () => {
	const cache = cacheWith({ now: 0, fingerprint: "a" });
	cache.set("search", { query: "x", server: "s" }, "/cwd", "found");
	assert.deepEqual(cache.get("search", { server: "s", query: "x" }, "/cwd"), { value: "found" });
});
