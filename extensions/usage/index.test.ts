import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import usage from "./index.ts";

test("usage is informational and no longer registers a tool guard or pacing commands", async () => {
	const events: string[] = [];
	let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
	usage({
		events: { on: () => {} },
		on: (event: string) => {
			events.push(event);
		},
		registerCommand: (_name: string, options: typeof command) => {
			command = options;
		},
	} as unknown as ExtensionAPI);

	assert.equal(events.includes("tool_call"), false);
	assert.deepEqual(command?.getArgumentCompletions?.("pacing"), []);
	assert.deepEqual(command?.getArgumentCompletions?.("sta"), [{ value: "status", label: "status" }]);
	const notices: Array<[string, string]> = [];
	await command?.handler("pacing off", {
		ui: { notify: (message: string, level: string) => notices.push([message, level]) },
	} as unknown as Parameters<NonNullable<typeof command>["handler"]>[1]);
	assert.deepEqual(notices, [["usage: unknown action (use /usage status)", "warning"]]);
});
