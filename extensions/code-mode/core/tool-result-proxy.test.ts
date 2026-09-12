import assert from "node:assert/strict";
import { test } from "node:test";

import { CodeModeToolResultProxy } from "./tool-result-proxy.ts";
import type { ResolvedCodeModeAction } from "./action-registry.ts";

const action = (provider: string): ResolvedCodeModeAction =>
	({
		provider,
		name: "run",
		ref: `${provider}.run`,
		description: "",
		inputSchema: {},
	}) as unknown as ResolvedCodeModeAction;

const proxyWith = (emitToolResult: (event: any) => unknown): CodeModeToolResultProxy =>
	new CodeModeToolResultProxy(() => ({ emitToolResult }) as any);

const value = { agent: "librarian", ok: true, output: "done" };

const run = (proxy: CodeModeToolResultProxy, provider = "agents") =>
	proxy.proxy({ action: action(provider), args: {}, toolCallId: "call-1", value });

test("a structured result survives middleware that returns identical content", async () => {
	// A scrubber that maps over the parts returns a FRESH array every time, even
	// when nothing changed. That must not collapse the value into its JSON text.
	const proxy = proxyWith((event) => ({
		content: event.content.map((part: any) => ({ ...part })),
	}));
	assert.deepEqual(await run(proxy), value);
});

test("a structured result survives middleware that rewrites the JSON text", async () => {
	const proxy = proxyWith((event) => ({
		content: event.content.map((part: any) => ({
			...part,
			text: part.text.replace("done", "REDACTED"),
		})),
	}));
	assert.deepEqual(await run(proxy), { ...value, output: "REDACTED" });
});

test("non-JSON replacement text is returned verbatim", async () => {
	const proxy = proxyWith(() => ({
		content: [{ type: "text", text: "result withheld" }],
	}));
	assert.equal(await run(proxy), "result withheld");
});

test("no patch leaves the value untouched", async () => {
	const proxy = proxyWith(() => undefined);
	assert.deepEqual(await run(proxy), value);
});

test("middleware supplied details win over content", async () => {
	const replacement = { agent: "librarian", ok: false, output: "patched" };
	const proxy = proxyWith((event) => ({
		content: event.content,
		details: { ...event.details, result: replacement },
	}));
	assert.deepEqual(await run(proxy), replacement);
});

test("pi and extensions keep their native lifecycle and skip the proxy", async () => {
	let emitted = false;
	const proxy = proxyWith(() => {
		emitted = true;
		return { content: [{ type: "text", text: "ignored" }] };
	});
	assert.deepEqual(await run(proxy, "pi"), value);
	assert.deepEqual(await run(proxy, "extensions"), value);
	assert.equal(emitted, false);
});
