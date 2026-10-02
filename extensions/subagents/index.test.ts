import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import subagents from "./index.ts";
import { isChildSession, TASK_FILE_FLAG } from "./constants.ts";
import { testHost, withParentSession } from "./test-host.ts";
import { TASK_DELIVERY_DELAY_MS } from "./task-delivery.ts";

test("standalone agents register only native codemode tools at session_start", async () => {
	await withParentSession(async () => {
		const host = testHost();
		subagents(host.api);
		assert.equal(host.tools.size, 0);
		assert.ok(host.flags.has(TASK_FILE_FLAG));
		await host.emit("session_start", { reason: "startup" });
		assert.deepEqual(
			[...host.tools.keys()].sort(),
			[
				"agents_cancel",
				"agents_list",
				"agents_models",
				"agents_run",
				"agents_runAll",
				"agents_start",
				"agents_status",
				"agents_wait",
			].sort(),
		);
		for (const definition of host.tools.values()) {
			const deferred = ["agents_models", "agents_list", "agents_status", "agents_cancel"].includes(definition.name);
			assert.equal(definition.exposure, deferred ? "deferred" : "codemode");
			assert.ok(definition.outputSchema);
			assert.ok(definition.annotations);
			assert.equal(definition.namespace?.name, "agents");
			assert.ok(definition.namespace?.instructions?.includes("tools.agents_wait"));
		}
		assert.deepEqual((await host.execute("agents_status", {})).structuredContent, []);
		await host.emit("session_start", { reason: "new" });
		assert.deepEqual((await host.execute("agents_status", {})).structuredContent, []);
		await host.emit("session_shutdown");
		assert.ok([...host.tools.values()].every((tool) => tool.exposure === "hidden"));
	});
});

test("subagent launch-call budget belongs to the native parent execution", async () => {
	await withParentSession(async () => {
		const host = testHost();
		subagents(host.api);
		await host.emit("session_start", { reason: "startup" });
		for (let i = 0; i < 100; i++) {
			assert.deepEqual(
				await host.emit("tool_call", {
					toolName: "agents_start",
					toolCallId: `outer/${i}`,
					parentToolCallId: "outer",
				}),
				[undefined],
			);
		}
		const blocked = await host.emit("tool_call", {
			toolName: "agents_run",
			toolCallId: "outer/101",
			parentToolCallId: "outer",
		});
		assert.equal((blocked[0] as { block: boolean }).block, true);
		await host.emit("tool_execution_end", { toolCallId: "outer" });
		assert.deepEqual(
			await host.emit("tool_call", { toolName: "agents_run", toolCallId: "outer/1", parentToolCallId: "outer" }),
			[undefined],
		);
		await host.emit("session_shutdown");
	});
});

test("child and background sessions retain task delivery flags but never agents tools", async () => {
	await withParentSession(async () => {
		for (const marker of ["PI_CODE_MODE_SUBAGENT", "PI_BACKGROUND_AGENT_ATTEMPT"]) {
			process.env[marker] = "1";
			const host = testHost();
			subagents(host.api);
			await host.emit("session_start", { reason: "startup" });
			assert.equal(host.tools.size, 0);
			assert.ok(host.flags.has(TASK_FILE_FLAG));
			await host.emit("session_shutdown");
			delete process.env[marker];
		}
	});
	assert.equal(isChildSession({ PI_CODE_MODE_SUBAGENT: "1" }), true);
	assert.equal(isChildSession({ PI_BACKGROUND_AGENT_ATTEMPT: "1" }), true);
	assert.equal(isChildSession({}), false);
});

test("a child delivers its compatibility task file once after native session_start", async () => {
	await withParentSession(async () => {
		process.env.PI_CODE_MODE_SUBAGENT = "1";
		const file = join(process.env.PI_CODING_AGENT_DIR!, "task.md");
		writeFileSync(file, "Task: review safely");
		const host = testHost();
		host.flags.set(TASK_FILE_FLAG, file);
		subagents(host.api);
		await host.emit("session_start", { reason: "startup" });
		assert.deepEqual(host.users, []);
		await new Promise((resolve) => setTimeout(resolve, TASK_DELIVERY_DELAY_MS + 50));
		assert.deepEqual(host.users, ["Task: review safely"]);
		await host.emit("session_start", { reason: "new" });
		await host.emit("session_shutdown");
		assert.deepEqual(host.users, ["Task: review safely"]);
		assert.equal(host.tools.size, 0);
	});
});

test("interactive progress is optional and its session timers are cleaned up", async () => {
	await withParentSession(async () => {
		for (const disabled of [false, true]) {
			const host = testHost();
			Object.assign(host.ctx, { mode: "tui", hasUI: true });
			host.flags.set("no-subagents-progress", disabled);
			subagents(host.api);
			await host.emit("session_start", { reason: "startup" });
			await host.emit("session_shutdown");
			const before = host.widgets.length;
			await new Promise((resolve) => setTimeout(resolve, 300));
			assert.equal(host.widgets.length, before);
		}
	});
});
