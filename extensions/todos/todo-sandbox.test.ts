import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import todosExtension from "./index.ts";
import { assertReadAllowed, assertWriteAllowed, resolveSandboxPolicy } from "../spindle/sandbox/policy.ts";

// The sandbox applies to a child agent's Pi tools and shell. Extension tools run
// in Pi's trusted host process, so the todo tool keeps the sole write capability.
test("a child cannot access the todo store directly while the todo tool can write it", async () => {
	const store = mkdtempSync(join(tmpdir(), "todo-sandbox-"));
	const previous = process.env.PI_TODO_PATH;
	let tool: any;
	try {
		process.env.PI_TODO_PATH = store;
		todosExtension({
			on: () => {},
			registerTool: (registered: unknown) => {
				tool = registered;
			},
			registerCommand: () => {},
		} as any);

		const policy = resolveSandboxPolicy(
			{ mode: "workspace-write", allowWrite: [store], denyRead: [store] },
			{ cwd: store, home: store, platform: "linux", env: {}, tmp: "/tmp" },
		);
		const directPath = join(store, "bypass.md");
		assert.throws(() => assertReadAllowed(policy, directPath), /denied by mode/);
		assert.throws(() => assertWriteAllowed(policy, directPath), /denied by mode/);

		await tool.execute(
			"call",
			{ action: "create", title: "Todo tool remains available" },
			new AbortController().signal,
			() => {},
			{
				cwd: store,
				sessionManager: { getSessionId: () => "child", getSessionFile: () => "/tmp/child.json" },
			} as any,
		);
		assert.equal(readdirSync(store).filter((entry) => entry.endsWith(".md")).length, 1);
		assert.equal(existsSync(directPath), false);
	} finally {
		if (previous === undefined) delete process.env.PI_TODO_PATH;
		else process.env.PI_TODO_PATH = previous;
		rmSync(store, { recursive: true, force: true });
	}
});
