import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import rootSearch from "./root-search.ts";

test("embedding entry registers only a root-search hook", () => {
	let hook: ((event: ToolCallEvent) => unknown) | undefined;
	rootSearch({
		on(name: string, handler: typeof hook) {
			assert.equal(name, "tool_call");
			hook = handler;
		},
	} as ExtensionAPI);
	assert.ok(hook);
	const call = (command: string) => hook!({ toolName: "bash", input: { command } } as ToolCallEvent);
	assert.equal(call("sed -i s/a/b/ file"), undefined);
	const blocked = call("find /") as { block: boolean; reason: string };
	assert.equal(blocked.block, true);
	assert.match(blocked.reason, /specific directory/);
	assert.doesNotMatch(blocked.reason, /guardrail off/);
});
