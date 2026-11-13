import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import filesystemGuard from "./filesystem-guard.ts";

test("filesystem entry blocks only root searches and unsafe rm targets", () => {
	let hook: ((event: ToolCallEvent) => unknown) | undefined;
	filesystemGuard({
		on(name: string, handler: typeof hook) {
			assert.equal(name, "tool_call");
			hook = handler;
		},
	} as ExtensionAPI);
	for (const command of ["find /", "rm -rf ~", "rm -rf /home/bob"]) {
		assert.equal(
			(hook!({ toolName: "bash", input: { command } } as ToolCallEvent) as { block: boolean }).block,
			true,
		);
	}
	assert.equal(hook!({ toolName: "bash", input: { command: "echo x > file" } } as ToolCallEvent), undefined);
});
