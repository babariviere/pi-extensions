import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionToolContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import nightMode from "./index.ts";
import { readActiveNightRun } from "./night-run.ts";
import { NIGHT_CATEGORIES } from "./plan.ts";
import { answerNightModePlanningQuery, NIGHT_MODE_PLANNING_QUERY_EVENT } from "./protocol.ts";
import { SANDBOX_REQUEST_EVENT, type SandboxRequestEvent } from "../sandbox/protocol.ts";

function harness() {
	const listeners = new Map<string, (value: unknown) => void>();
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const tools = new Map<string, ToolDefinition<any, any>>();
	const emissions: { name: string; value: unknown }[] = [];
	const messages: string[] = [];
	const entries: unknown[] = [];
	let command!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
	nightMode({
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, handler),
		events: {
			on: (name: string, handler: (value: unknown) => void) => {
				listeners.set(name, handler);
				return () => {
					listeners.delete(name);
				};
			},
			emit: (name: string, value: unknown) => {
				emissions.push({ name, value });
				listeners.get(name)?.(value);
			},
		},
		registerTool: (tool: ToolDefinition<any, any>) => tools.set(tool.name, tool),
		registerCommand: (_name: string, value: { handler: typeof command }) => {
			command = value.handler;
		},
		setModel: async () => true,
		sendUserMessage: (message: string) => messages.push(message),
		appendEntry: (...entry: unknown[]) => entries.push(entry),
	} as unknown as ExtensionAPI);
	return {
		listeners,
		handlers,
		tools,
		emissions,
		messages,
		entries,
		command: (args: string, ctx: ExtensionCommandContext) => command(args, ctx),
	};
}

const task = {
	title: "Scan Slack",
	goal: "Read the thread and summarize",
	repository: "/repo",
	definitionOfDone: "Return one summary",
	category: "slack",
	outputs: [],
	permissions: [],
};
const omissions = NIGHT_CATEGORIES.filter((category) => category !== "slack").map((category) => ({
	category,
	reason: "Explicitly excluded",
}));

describe("native night plan tool", () => {
	it("registers a codemode tool directly, without provider registration or discovery", async () => {
		const mock = harness();
		assert.deepEqual([...mock.tools.keys()], ["night_plan"]);
		assert.ok([...mock.listeners.keys()].every((name) => !name.startsWith("code-mode:")));
		assert.deepEqual(mock.emissions, []);
		const tool = mock.tools.get("night_plan")!;
		assert.equal(tool.exposure, "codemode");
		assert.equal(tool.namespace?.name, "night");
		assert.ok(tool.outputSchema);
		assert.ok(tool.parameters.properties.tasks);
		await assert.rejects(
			tool.execute("plan", { tasks: [task] }, undefined, undefined, {} as ExtensionToolContext),
			/No night planning/,
		);
		await assert.rejects(
			tool.execute("plan", { tasks: [] }, undefined, undefined, {} as ExtensionToolContext),
			/Invalid arguments/,
		);
	});

	it("keeps planning read-only until explicit approval and returns structured review results", async () => {
		const dir = mkdtempSync(join(tmpdir(), "native-night-plan-"));
		const previousDir = process.env.PI_CODING_AGENT_DIR;
		const previousCwd = process.cwd();
		const mock = harness();
		let approve = false;
		const ctx = {
			cwd: dir,
			mode: "tui",
			hasUI: true,
			tools: [],
			executeTool: async () => {
				throw new Error("Unexpected nested execution");
			},
			isIdle: () => true,
			sessionManager: { getSessionId: () => "planner" },
			modelRegistry: { find: () => ({ provider: "test", id: "planner" }) },
			ui: {
				notify() {},
				setStatus() {},
				custom: async (
					factory: (
						tui: object,
						theme: object,
						bindings: object,
						done: (value: unknown) => void,
					) => { handleInput(input: string): void },
				) => {
					let result: unknown;
					const widget = factory(
						{ requestRender() {} },
						{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
						{},
						(value) => {
							result = value;
						},
					);
					if (approve) {
						widget.handleInput(" ");
						widget.handleInput("\r");
					} else widget.handleInput("\u001b");
					return result;
				},
			},
		} as unknown as ExtensionCommandContext & ExtensionToolContext;
		try {
			process.env.PI_CODING_AGENT_DIR = dir;
			process.chdir(dir);
			writeFileSync(join(dir, "prompt.md"), "Read-only standing routine");
			writeFileSync(
				join(dir, "settings.json"),
				JSON.stringify({
					nightMode: { promptPath: join(dir, "prompt.md"), plannerModel: "test/planner", wakeLock: "caffeinate" },
				}),
			);
			await mock.command("start", ctx);
			assert.equal(readActiveNightRun()?.sandbox?.mode, "read-only");
			assert.equal(readActiveNightRun()?.mcp?.readOnly, true);
			const sandbox = mock.emissions.find((event) => event.name === SANDBOX_REQUEST_EVENT)
				?.value as SandboxRequestEvent;
			assert.equal(sandbox.policy?.mode, "read-only");
			assert.match(mock.messages[0], /tools\.night_plan/);

			const tool = mock.tools.get("night_plan")!;
			const invoke = (args: Record<string, unknown>) => tool.execute("plan", args, undefined, undefined, ctx);
			await assert.rejects(invoke({ tasks: [task] }), /Plan incomplete/);
			await assert.rejects(
				invoke({ tasks: [{ ...task, permissions: ["mcp-write"] }], omissions }),
				/MCP writes are disabled/,
			);
			const dismissed = await invoke({ tasks: [task], omissions });
			assert.ok(Value.Check(tool.outputSchema!, dismissed.structuredContent));
			const dismissedValue = dismissed.structuredContent as Record<string, unknown>;
			assert.equal(dismissedValue.status, "dismissed");
			assert.equal(dismissedValue.approved, undefined);
			const query = { version: 1 as const, planning: false };
			mock.listeners.get(NIGHT_MODE_PLANNING_QUERY_EVENT)?.(query);
			assert.equal(query.planning, true);
			await mock.handlers.get("agent_settled")?.({}, ctx);
			assert.equal(mock.messages.length, 1, "dismissal must not restart review or execution");

			approve = true;
			const approved = await invoke({ tasks: [task], omissions });
			assert.ok(Value.Check(tool.outputSchema!, approved.structuredContent));
			const approvedValue = approved.structuredContent as Record<string, unknown>;
			assert.equal(approvedValue.status, "approved");
			assert.deepEqual(approvedValue.approved, [task]);
			if (approved.content[0]?.type === "text")
				assert.deepEqual(JSON.parse(approved.content[0].text), approved.structuredContent);
			assert.deepEqual(mock.entries, [], "the tool reviews tasks, it never starts an execution run");
			assert.equal(readActiveNightRun()?.approvedTaskIds, undefined);
		} finally {
			await mock.handlers.get("session_shutdown")?.({}, ctx);
			process.chdir(previousCwd);
			if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousDir;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("planning state query", () => {
	it("answers only versioned mutable query envelopes", () => {
		const query = { version: 1 as const, planning: false };
		answerNightModePlanningQuery(query, true);
		assert.equal(query.planning, true);
		const wrongVersion = { version: 2, planning: false };
		answerNightModePlanningQuery(wrongVersion, true);
		assert.equal(wrongVersion.planning, false);
	});

	it("registers a load-order-independent planning query listener", () => {
		const mock = harness();
		const query = { version: 1 as const, planning: true };
		mock.listeners.get(NIGHT_MODE_PLANNING_QUERY_EVENT)?.(query);
		assert.equal(query.planning, false);
	});
});
