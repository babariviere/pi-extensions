import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import idleExit from "./index.ts";

test("Ctrl+D exits only when idle with an empty editor", async () => {
	let handler: ((ctx: ExtensionContext) => void | Promise<void>) | undefined;
	idleExit({
		registerShortcut: (key, options) => {
			assert.equal(key, "ctrl+d");
			handler = options.handler;
		},
	} as ExtensionAPI);
	assert.ok(handler);

	for (const [idle, text, shouldExit] of [
		[false, "", false],
		[false, "draft", false],
		[true, "draft", false],
		[true, "", true],
	] as const) {
		let exits = 0;
		const ctx = {
			isIdle: () => idle,
			ui: { getEditorText: () => text },
			shutdown: () => {
				exits++;
			},
		} as ExtensionContext;
		await handler(ctx);
		assert.equal(exits, shouldExit ? 1 : 0, `idle=${idle}, text=${JSON.stringify(text)}`);
	}
});
