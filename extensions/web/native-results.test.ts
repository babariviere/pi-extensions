import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import webExtension from "./index.ts";
import { createWebTool } from "./tool.ts";
import { DEFAULT_SETTINGS } from "./settings.ts";
import { cloneCachePath, MAX_RESPONSE_BYTES, parseGitHubRepoUrl } from "./utils.ts";

const settings = { ...DEFAULT_SETTINGS, browserFallback: false };

function structured(result: { structuredContent?: unknown }): Record<string, unknown> {
	assert.ok(result.structuredContent && typeof result.structuredContent === "object");
	return result.structuredContent as Record<string, unknown>;
}

test("web registers one direct tool, no legacy aliases, and conservative native metadata", () => {
	const registered: string[] = [];
	webExtension({
		registerTool(tool: { name: string }) {
			registered.push(tool.name);
		},
		registerCommand() {},
	} as unknown as ExtensionAPI);
	assert.deepEqual(registered, ["web"]);
	const tool = createWebTool(settings);
	assert.equal(tool.name, "web");
	assert.equal(tool.exposure ?? "direct", "direct");
	assert.equal(tool.namespace?.name, "web");
	assert.equal(tool.annotations?.destructiveHint, false);
	assert.equal(tool.annotations?.openWorldHint, true);
	assert.equal(tool.annotations?.readOnlyHint, false, "fetch can create local clone caches and files");
	assert.equal(tool.annotations?.idempotentHint, false, "repeated large fetches create fresh temp files");
	assert.ok(tool.outputSchema);
});

test("web has a flat object input schema and validates the selected action before execution", async (t) => {
	const tool = createWebTool(settings);
	const schema = tool.parameters;
	assert.equal(schema.type, "object");
	assert.deepEqual(Object.keys(schema.properties), ["action", "query", "limit", "url", "timeout"]);
	let calls = 0;
	t.mock.method(globalThis, "fetch", async () => {
		calls++;
		throw new Error("No network expected");
	});
	for (const input of [
		{ action: "search", query: "fixture" },
		{ action: "search", query: "fixture", limit: 20 },
		{ action: "fetch", url: "https://example.com" },
		{ action: "fetch", url: "https://example.com", timeout: 1000 },
	])
		assert.ok(Value.Check(schema, input), JSON.stringify(input));
	for (const input of [
		{},
		{ query: "fixture" },
		{ url: "https://example.com" },
		{ action: "other", query: "fixture" },
		{ action: "search", url: "https://example.com" },
		{ action: "fetch", query: "fixture" },
		{ action: "search", query: "fixture", url: "https://example.com" },
		{ action: "fetch", url: "https://example.com", query: "fixture" },
		{ action: "search", query: "fixture", extra: true },
		{ action: "search", query: "fixture", limit: 0 },
		{ action: "search", query: "fixture", limit: 21 },
		{ action: "fetch", url: "https://example.com", timeout: 999 },
	])
		await assert.rejects(
			tool.execute("invalid", input as never, undefined, undefined, {} as never),
			/Invalid web arguments/,
			JSON.stringify(input),
		);
	assert.equal(calls, 0);
});

test("search returns ranked structured links alongside unchanged Markdown", async (t) => {
	t.mock.method(
		globalThis,
		"fetch",
		async () =>
			new Response(
				'<div class="search-result"><a class="__sri_title_link" href="https://example.com/">Title</a><div class="__sri-desc">Snippet</div></div>',
			),
	);
	const previous = process.env.KAGI_SESSION_TOKEN;
	process.env.KAGI_SESSION_TOKEN = "test-session";
	try {
		const tool = createWebTool(settings);
		const result = await tool.execute(
			"search",
			{ action: "search", query: "fixture", limit: 1 },
			undefined,
			undefined,
			{} as never,
		);
		assert.deepEqual(result.content, [{ type: "text", text: "1. [Title](https://example.com/)\n   Snippet" }]);
		assert.deepEqual(result.structuredContent, {
			query: "fixture",
			results: [{ title: "Title", url: "https://example.com/", snippet: "Snippet" }],
		});
		assert.ok(Value.Check(tool.outputSchema!, result.structuredContent));
		assert.equal(result.isError, undefined);
		assert.equal(result.details, undefined);
	} finally {
		if (previous === undefined) delete process.env.KAGI_SESSION_TOKEN;
		else process.env.KAGI_SESSION_TOKEN = previous;
	}
});

test("search failures carry structured data and the native isError flag", async (t) => {
	t.mock.method(globalThis, "fetch", async () => new Response("unauthorized", { status: 401 }));
	const previous = process.env.KAGI_SESSION_TOKEN;
	process.env.KAGI_SESSION_TOKEN = "test-session";
	try {
		const tool = createWebTool(settings);
		const result = await tool.execute(
			"search",
			{ action: "search", query: "fixture" },
			undefined,
			undefined,
			{} as never,
		);
		assert.equal(result.isError, true);
		const data = structured(result);
		assert.match(String(data.error), /Kagi rejected.*401/);
		assert.deepEqual(data.results, []);
		assert.deepEqual(result.content, [{ type: "text", text: data.error }]);
		assert.ok(Value.Check(tool.outputSchema!, data));
	} finally {
		if (previous === undefined) delete process.env.KAGI_SESSION_TOKEN;
		else process.env.KAGI_SESSION_TOKEN = previous;
	}
});

test("fetch keeps full structured text while direct output is truncated", async (t) => {
	const body = Array.from({ length: 2100 }, (_, i) => `line ${i}`).join("\n");
	t.mock.method(globalThis, "fetch", async () => new Response(body, { headers: { "content-type": "text/plain" } }));
	const tool = createWebTool(settings);
	for (const url of ["https://raw.githubusercontent.com/example/repo/main/file.txt", "https://example.com/file.txt"]) {
		const result = await tool.execute(
			"fetch",
			{ action: "fetch", url: ` ${url} ` },
			undefined,
			undefined,
			{} as never,
		);
		const data = structured(result);
		assert.equal(data.url, url);
		assert.equal(data.text, body);
		assert.equal(data.status, 200);
		assert.equal(data.contentType, "text/plain");
		assert.equal(data.source, url.includes("raw.githubusercontent.com") ? "raw" : "defuddle");
		assert.ok(Value.Check(tool.outputSchema!, data));
		assert.deepEqual(result.details, { source: data.source });
		const content = result.content[0];
		assert.equal(content.type, "text");
		if (content.type !== "text") throw new Error("Expected text");
		assert.ok(!content.text.includes("line 2099"));
		const path = content.text.match(/Full content: (.+)\]/)?.[1];
		assert.ok(path);
		try {
			assert.equal(readFileSync(path, "utf8"), body);
		} finally {
			unlinkSync(path);
		}
	}
});

test("fetch HTTP and transport failures propagate as native errors with useful data", async (t) => {
	const tool = createWebTool(settings);
	t.mock.method(globalThis, "fetch", async () => new Response("missing", { status: 404 }));
	for (const url of ["https://raw.githubusercontent.com/example/repo/main/missing", "https://example.com/missing"]) {
		const result = await tool.execute("fetch", { action: "fetch", url }, undefined, undefined, {} as never);
		assert.equal(result.isError, true);
		const data = structured(result);
		assert.equal(data.url, url);
		assert.equal(data.status, 404);
		assert.match(String(data.error), /HTTP 404/);
		assert.deepEqual(result.content, [{ type: "text", text: data.error }]);
		assert.ok(Value.Check(tool.outputSchema!, data));
	}
	t.mock.method(globalThis, "fetch", async () => {
		throw new Error("offline");
	});
	const result = await tool.execute(
		"fetch",
		{ action: "fetch", url: "https://example.com/page" },
		undefined,
		undefined,
		{} as never,
	);
	assert.equal(result.isError, true);
	assert.match(String(structured(result).error), /offline/);
});

test("fetch does not expose oversized network bodies as structured data", async (t) => {
	t.mock.method(globalThis, "fetch", async () => new Response("x".repeat(MAX_RESPONSE_BYTES + 1)));
	const tool = createWebTool(settings);
	const result = await tool.execute(
		"fetch",
		{ action: "fetch", url: "https://raw.githubusercontent.com/example/repo/main/huge" },
		undefined,
		undefined,
		{} as never,
	);
	assert.equal(result.isError, true);
	assert.match(String(structured(result).error), /byte limit/);
	assert.ok(String(structured(result).text).length < 200);
});

test("soft not-found pages produce structured errors even with HTTP 200", async (t) => {
	t.mock.method(
		globalThis,
		"fetch",
		async () =>
			new Response("# Page not found\n\nThis page was removed.", { headers: { "content-type": "text/plain" } }),
	);
	const tool = createWebTool(settings);
	const result = await tool.execute(
		"fetch",
		{ action: "fetch", url: "https://example.com/gone" },
		undefined,
		undefined,
		{} as never,
	);
	assert.equal(result.isError, true);
	assert.equal(structured(result).status, 200);
	assert.match(String(structured(result).error), /not found.*placeholder/);
	assert.ok(Value.Check(tool.outputSchema!, result.structuredContent));
});

test("binary raw responses preserve the direct diagnostic without exposing bytes", async (t) => {
	t.mock.method(
		globalThis,
		"fetch",
		async () => new Response("binary bytes", { headers: { "content-type": "application/pdf" } }),
	);
	const url = "https://raw.githubusercontent.com/example/repo/main/file.pdf";
	const tool = createWebTool(settings);
	const result = await tool.execute("fetch", { action: "fetch", url }, undefined, undefined, {} as never);
	assert.notEqual(result.isError, true);
	assert.equal(structured(result).contentType, "application/pdf");
	assert.equal(structured(result).text, `Binary content (content-type: application/pdf); not rendered. URL: ${url}`);
	assert.ok(Value.Check(tool.outputSchema!, result.structuredContent));
});

test("cached GitHub summaries expose a structured repository path without network access", async (t) => {
	const url = `https://github.com/pi-native-test-${randomUUID()}/repo`;
	const ref = parseGitHubRepoUrl(url);
	assert.ok(ref);
	const dir = cloneCachePath(ref);
	mkdirSync(join(dir, ".git"), { recursive: true });
	writeFileSync(join(dir, "README.md"), "# Fixture repo\nREADME content.");
	t.after(() => rmSync(join(dir, ".."), { recursive: true, force: true }));
	t.mock.method(globalThis, "fetch", async () => {
		throw new Error("No network expected");
	});
	const tool = createWebTool(settings);
	const result = await tool.execute("fetch", { action: "fetch", url }, undefined, undefined, {} as never);
	const data = structured(result);
	assert.equal(data.repositoryPath, dir);
	assert.equal(data.source, "github");
	assert.match(String(data.text), /Reused existing clone/);
	assert.match(String(data.text), /README content/);
	assert.deepEqual(result.content, [{ type: "text", text: data.text }]);
	assert.deepEqual(result.details, { source: "github" });
	assert.ok(Value.Check(tool.outputSchema!, data));
});
