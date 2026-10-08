import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import { test } from "node:test";
import * as sdk from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { scrubToolResult } from "../secrets/secret-mask.ts";
import { SecretRefRegistry } from "../secrets/secret-ref.ts";
import { createWebTool } from "./tool.ts";
import { DEFAULT_SETTINGS } from "./settings.ts";

// Older hosts can still run the direct-output tests. This integration exercises
// the real native codemode sandbox when pi 0.99+ supplies it.
const { createCodemodeExtension } = sdk as unknown as {
	createCodemodeExtension?: (options: { models: boolean }) => (pi: ExtensionAPI) => void;
};

type ScriptTool = {
	execute: (
		id: string,
		input: { code: string },
		signal: undefined,
		update: undefined,
		context: unknown,
	) => Promise<{ content: { type: string; text?: string }[]; details?: unknown; isError?: boolean }>;
};

test("native codemode receives full web data, scrubbed structured values, and error data", {
	skip: !createCodemodeExtension && "Native codemode requires pi 0.99+",
}, async (t) => {
	let codemode: ScriptTool | undefined;
	const web = createWebTool({ ...DEFAULT_SETTINGS, browserFallback: false });
	createCodemodeExtension!({ models: false })({
		registerTool(tool: unknown) {
			codemode = tool as ScriptTool;
		},
		getAllTools() {
			return [web];
		},
		appendEntry() {},
	} as unknown as ExtensionAPI);
	assert.ok(codemode);
	const secret = { name: "TOKEN", value: "supersecretvalue123" };
	const registry = new SecretRefRegistry();
	const previousToken = process.env.KAGI_SESSION_TOKEN;
	process.env.KAGI_SESSION_TOKEN = "test-session";
	t.after(() => {
		if (previousToken === undefined) delete process.env.KAGI_SESSION_TOKEN;
		else process.env.KAGI_SESSION_TOKEN = previousToken;
	});
	const body = `${Array.from({ length: 2100 }, (_, i) => `line ${i}`).join("\n")}\n${secret.value}`;
	t.mock.method(globalThis, "fetch", async (url: string) =>
		url.startsWith("https://kagi.com/html/search?")
			? new Response(
					'<div class="search-result"><a class="__sri_title_link" href="https://example.com/page">Fixture</a><div class="__sri-desc">Snippet</div></div>',
				)
			: url.endsWith("missing")
				? new Response("not found", { status: 404 })
				: new Response(body, { headers: { "content-type": "text/plain" } }),
	);
	let calls = 0;
	const context = {
		tools: [web],
		sessionManager: { getBranch: () => [] },
		async executeTool(
			name: string,
			args: { action: "fetch"; url: string } | { action: "search"; query: string; limit?: number },
		) {
			assert.equal(name, web.name);
			const id = `native/${++calls}`;
			const result = await web.execute(id, args, undefined, undefined, {} as never);
			for (const part of result.content) {
				if (part.type !== "text") continue;
				const path = part.text.match(/Full content: (.+)\]/)?.[1];
				if (path) t.after(() => unlinkSync(path));
			}
			// Model the tool_result middleware boundary, including a structured-only
			// secret hidden beyond the model-facing truncation.
			const patch = scrubToolResult(result, [secret], registry);
			return { toolCall: { id }, result: { ...result, ...patch }, isError: result.isError === true };
		},
	};
	const result = await codemode.execute(
		"native",
		{
			code: `
const search = await tools.web({ action: "search", query: "fixture", limit: 1 });
const page = await tools.web({ action: "fetch", url: search.results[0].url });
const missing = await tools.web({ action: "fetch", url: "https://example.com/missing" });
return { query: search.query, title: search.results[0].title, tail: page.text.includes("line 2099"), safe: !page.text.includes("supersecretvalue123"), ref: page.text.includes("<secret:token:"), status: missing.status, error: missing.error };
`,
		},
		undefined,
		undefined,
		context,
	);
	assert.notEqual(result.isError, true, "Structured error data remains available to the script");
	const output = result.content.map((part) => part.text ?? "").join("\n");
	assert.match(output, /"query"\s*:\s*"fixture"/);
	assert.match(output, /"title"\s*:\s*"Fixture"/);
	assert.match(output, /"tail"\s*:\s*true/);
	assert.match(output, /"safe"\s*:\s*true/);
	assert.match(output, /"ref"\s*:\s*true/);
	assert.match(output, /"status"\s*:\s*404/);
	assert.match(output, /HTTP 404/);
	assert.deepEqual(
		(result.details as { calls: { status: string }[] }).calls.map((call) => call.status),
		["ok", "ok", "error"],
	);
});
