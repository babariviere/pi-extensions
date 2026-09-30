import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createCodemodeExtension, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import extension, { createApplyPatchTool, OpenAIEditToolPolicy } from "./index.ts";

test("the standalone extension registers applyPatch, not an execution runtime", () => {
	const registered: ToolDefinition<any, any>[] = [];
	extension({
		registerTool: (tool: ToolDefinition<any, any>) => registered.push(tool),
		on: () => () => {},
	} as unknown as ExtensionAPI);
	assert.deepEqual(
		registered.map((tool) => tool.name),
		["applyPatch"],
	);
	assert.equal(registered[0]?.exposure, "direct");
	assert.equal(registered[0]?.executionMode, "sequential");
	assert.ok(registered[0]?.outputSchema);
});

test("OpenAI models disable edit/write without removing other tools or restoring explicit exclusions", () => {
	let active = ["read", "bash", "edit", "write", "codemode", "applyPatch"];
	const policy = new OpenAIEditToolPolicy({
		getActiveTools: () => active,
		setActiveTools: (next) => {
			active = next;
		},
	});
	policy.apply({ provider: "openai", id: "gpt-6.1-sol" });
	assert.deepEqual(active, ["read", "bash", "codemode", "applyPatch"]);
	policy.apply({ provider: "anthropic", id: "claude-opus-5.5" });
	assert.ok(active.includes("edit") && active.includes("write"));
	active = ["read", "bash", "codemode", "applyPatch"];
	policy.apply({ provider: "openai-codex" });
	policy.apply({ provider: "anthropic" });
	assert.deepEqual(active, ["read", "bash", "codemode", "applyPatch"]);
});

test("OpenAI edit policy covers startup, model switches and nested tool calls", () => {
	let active = ["read", "bash", "edit", "write", "codemode"];
	const handlers = new Map<string, (...args: any[]) => any>();
	extension({
		registerTool: () => {},
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => {
			active = names;
		},
		on: (name: string, handler: (...args: any[]) => any) => {
			handlers.set(name, handler);
			return () => {};
		},
	} as unknown as ExtensionAPI);
	const openai = { model: { provider: "openai-codex", id: "gpt-6.1-sol" } };
	handlers.get("session_start")!({}, openai);
	assert.deepEqual(active, ["read", "bash", "codemode"]);
	for (const toolName of ["edit", "write"]) {
		for (const parentToolCallId of [undefined, "native"]) {
			assert.equal(handlers.get("tool_call")!({ toolName, parentToolCallId }, openai).block, true);
		}
	}
	assert.equal(handlers.get("tool_call")!({ toolName: "applyPatch" }, openai), undefined);
	handlers.get("model_select")!({ model: { provider: "anthropic" } });
	assert.ok(active.includes("edit") && active.includes("write"));
	assert.equal(handlers.get("tool_call")!({ toolName: "write" }, { model: { provider: "anthropic" } }), undefined);
	handlers.get("before_agent_start")!({}, openai);
	assert.deepEqual(active, ["read", "bash", "codemode"]);
});

test("native codemode calls the standalone V4A tool and receives change metadata", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "native-apply-patch-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const patch = createApplyPatchTool(cwd);
	let codemode: ToolDefinition<any, any> | undefined;
	createCodemodeExtension({ models: false })({
		registerTool: (tool: ToolDefinition<any, any>) => {
			codemode = tool;
		},
		getAllTools: () => [patch],
		getSettings: () => ({}),
		appendEntry: () => {},
	} as unknown as ExtensionAPI);
	assert.ok(codemode);
	const context = {
		cwd,
		tools: [patch],
		sessionManager: { getBranch: () => [] },
		async executeTool(name: string, args: unknown) {
			assert.equal(name, "applyPatch");
			return {
				toolCall: { id: "native/1" },
				result: await patch.execute("native/1", args, undefined, undefined, this as never),
				isError: false,
			};
		},
	};
	const result = await codemode.execute(
		"native",
		{
			code: 'return await tools.applyPatch({ patch: "*** Begin Patch\\n*** Add File: hello.txt\\n+hello\\n*** End Patch" });',
		},
		undefined,
		undefined,
		context as never,
	);
	assert.notEqual(result.isError, true);
	assert.match(result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n"), /"kind"\s*:\s*"add"/);
	assert.equal(readFileSync(join(cwd, "hello.txt"), "utf8"), "hello\n");
});

test("the standalone tool guards both paths of a move before mutation", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "guarded-apply-patch-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const tool = createApplyPatchTool(cwd, (path) => {
		if (path.endsWith("blocked.txt")) throw new Error("blocked path");
	});
	await assert.rejects(
		tool.execute(
			"patch",
			{
				patch: "*** Begin Patch\n*** Update File: source.txt\n*** Move to: blocked.txt\n@@\n-old\n+new\n*** End Patch",
			},
			undefined,
			undefined,
			{ cwd } as never,
		),
		/blocked path/,
	);
});
