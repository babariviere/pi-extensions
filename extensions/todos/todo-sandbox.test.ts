import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionToolContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { assertReadAllowed, assertWriteAllowed, resolveSandboxPolicy } from "../sandbox/policy.ts";
import { NIGHT_MODE_PLANNING_QUERY_EVENT, type NightModePlanningQuery } from "../night-mode/protocol.ts";
import todosExtension from "./index.ts";

// The sandbox applies to a child's Pi tools and shell. Native todo tools run in
// Pi's trusted host process and retain the sole write capability for this store.
test("native todo tools can manage the store while direct child access is denied", async () => {
	const store = mkdtempSync(join(tmpdir(), "todo-sandbox-"));
	const previous = process.env.PI_TODO_PATH;
	const tools = new Map<string, ToolDefinition<any, any>>();
	const listeners: string[] = [];
	const emissions: string[] = [];
	const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>();
	let planning = false;
	try {
		process.env.PI_TODO_PATH = store;
		todosExtension({
			on: (name: string, handler: (event: any, ctx: ExtensionContext) => any) => handlers.set(name, handler),
			events: {
				on: (event: string) => {
					listeners.push(event);
					return () => {};
				},
				emit: (event: string, value: unknown) => {
					emissions.push(event);
					if (event === NIGHT_MODE_PLANNING_QUERY_EVENT) (value as NightModePlanningQuery).planning = planning;
				},
			},
			registerTool: (tool: ToolDefinition<any, any>) => tools.set(tool.name, tool),
			registerCommand() {},
		} as unknown as ExtensionAPI);

		assert.deepEqual(
			[...tools.keys()],
			[
				"todo_list",
				"todo_listAll",
				"todo_get",
				"todo_create",
				"todo_update",
				"todo_append",
				"todo_delete",
				"todo_claim",
				"todo_release",
			],
		);
		assert.deepEqual(listeners, []);
		assert.deepEqual(emissions, []);
		for (const tool of tools.values()) {
			const deferred = ["todo_listAll", "todo_delete", "todo_release"].includes(tool.name);
			assert.equal(tool.exposure, deferred ? "deferred" : "codemode");
			assert.equal(tool.namespace?.name, "todo");
			assert.ok(tool.outputSchema);
			assert.equal(tool.annotations?.readOnlyHint, ["todo_list", "todo_listAll", "todo_get"].includes(tool.name));
		}
		assert.ok(tools.get("todo_claim")?.namespace?.instructions?.includes("tools.todo_claim"));
		assert.equal(tools.has("todo_list-all"), false);

		const ctx = {
			cwd: store,
			hasUI: false,
			tools: [],
			executeTool: async () => {
				throw new Error("Unexpected nested execution");
			},
			sessionManager: { getSessionId: () => "child", getSessionFile: () => "/tmp/child.json" },
		} as unknown as ExtensionToolContext;
		const invoke = async (name: string, args: Record<string, unknown> = {}, signal?: AbortSignal) => {
			const tool = tools.get(name);
			assert.ok(tool);
			const result = await tool.execute("native-todo-call", args, signal, undefined, ctx);
			assert.ok(Value.Check(tool.outputSchema!, result.structuredContent));
			assert.equal(result.content[0]?.type, "text");
			if (result.content[0]?.type === "text")
				assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
			return result.structuredContent as any;
		};

		const policy = resolveSandboxPolicy(
			{ mode: "workspace-write", allowWrite: [store], denyRead: [store] },
			{ cwd: store, home: store, platform: "linux", env: {}, tmp: "/tmp" },
		);
		const directPath = join(store, "bypass.md");
		assert.throws(() => assertReadAllowed(policy, directPath), /denied by mode/);
		assert.throws(() => assertWriteAllowed(policy, directPath), /denied by mode/);

		const promptEvent = {
			systemPrompt: "Base prompt",
			systemPromptOptions: { sections: { todo_tracking: "stale" } },
		};
		handlers.get("before_agent_start")?.(promptEvent, ctx);
		assert.equal(Object.hasOwn(promptEvent.systemPromptOptions.sections, "todo_tracking"), false);

		const created = await invoke("todo_create", {
			title: "Native todo tools remain available",
			tags: ["test"],
			body: "Initial",
		});
		assert.match(created.id, /^TODO-[a-f0-9]{8}$/);
		assert.equal(created.title, "Native todo tools remain available");
		assert.equal(readdirSync(store).filter((entry) => entry.endsWith(".md")).length, 1);
		assert.equal(existsSync(directPath), false);
		const createdPromptEvent = { ...promptEvent, systemPromptOptions: { sections: {} as Record<string, string> } };
		handlers.get("before_agent_start")?.(createdPromptEvent, ctx);
		assert.match(createdPromptEvent.systemPromptOptions.sections.todo_tracking, /tools/);
		assert.match(createdPromptEvent.systemPromptOptions.sections.todo_tracking, /1 open todo/);

		const appended = await invoke("todo_append", { id: created.id, body: "Progress" });
		assert.equal(appended.body, "Initial\n\nProgress\n");
		const claimed = await invoke("todo_claim", { id: created.id });
		assert.equal(claimed.assigned_to_session, "child");
		const released = await invoke("todo_release", { id: created.id });
		assert.equal(released.assigned_to_session, undefined);
		const closed = await invoke("todo_update", { id: created.id, status: "closed" });
		assert.equal(closed.status, "closed");
		assert.deepEqual(await invoke("todo_list"), []);
		assert.equal((await invoke("todo_listAll"))[0]?.id, created.id);
		planning = true;
		assert.equal((await invoke("todo_get", { id: created.id })).id, created.id);
		assert.deepEqual(await invoke("todo_list"), []);
		assert.equal((await invoke("todo_listAll")).length, 1);
		for (const [name, args] of [
			["todo_create", { title: "blocked" }],
			["todo_update", { id: created.id, title: "blocked" }],
			["todo_append", { id: created.id, body: "blocked" }],
			["todo_delete", { id: created.id }],
			["todo_claim", { id: created.id }],
			["todo_release", { id: created.id }],
		] as const)
			await assert.rejects(invoke(name, args), /planning is read-only/);
		planning = false;
		assert.equal((await invoke("todo_get", { id: created.id })).body, "Initial\n\nProgress\n");
		await assert.rejects(invoke("todo_get"), /Invalid arguments for todo\.get/);
		await assert.rejects(invoke("todo_create", { title: "Bad", extra: true }), /Invalid arguments/);
		await assert.rejects(
			invoke("todo_create", { title: "Aborted" }, AbortSignal.abort(new Error("cancelled"))),
			/cancelled/,
		);

		// A competing host mutation must still honor the file lock.
		const lockPath = join(store, `${created.id.slice(5)}.lock`);
		writeFileSync(lockPath, JSON.stringify({ session: "other", created_at: new Date().toISOString() }));
		await assert.rejects(invoke("todo_update", { id: created.id, title: "locked" }), /is locked/);
		rmSync(lockPath);
		await invoke("todo_update", { id: created.id, title: "Unlocked" });
		assert.equal(existsSync(lockPath), false);

		const night = await invoke("todo_create", { title: "Night evidence", tags: ["night"] });
		await assert.rejects(invoke("todo_update", { id: night.id, status: "closed" }), /Evidence/);
		assert.equal((await invoke("todo_get", { id: night.id })).status, "open");
		await invoke("todo_delete", { id: night.id });
		assert.equal((await invoke("todo_delete", { id: created.id })).id, created.id);
		assert.deepEqual(await invoke("todo_listAll"), []);
		assert.ok(emissions.every((event) => event === NIGHT_MODE_PLANNING_QUERY_EVENT));
	} finally {
		if (previous === undefined) delete process.env.PI_TODO_PATH;
		else process.env.PI_TODO_PATH = previous;
		rmSync(store, { recursive: true, force: true });
	}
});
