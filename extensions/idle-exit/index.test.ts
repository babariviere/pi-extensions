import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import idleExit from "./index.ts";

test("Ctrl+D exits only when idle with an empty editor", async (t) => {
	const signal = t.mock.method(process, "kill", () => true);
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
		const ctx = {
			isIdle: () => idle,
			ui: { getEditorText: () => text },
		} as ExtensionContext;
		const previousSignals = signal.mock.calls.length;
		await handler(ctx);
		assert.equal(
			signal.mock.calls.length - previousSignals,
			shouldExit ? 1 : 0,
			`idle=${idle}, text=${JSON.stringify(text)}`,
		);
	}
	assert.deepEqual(signal.mock.calls[0]?.arguments, [process.pid, "SIGTERM"]);
});
