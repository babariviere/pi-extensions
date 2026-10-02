import assert from "node:assert/strict";
import { test } from "node:test";
import { createCodemodeExtension, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createActionTool } from "../shared/action-tools.ts";
import { AgentRunRegistry } from "./agent-run-monitor.ts";
import { AgentsProvider } from "./agents-provider.ts";

test("native codemode describes the subagent result union instead of an unknown result", async (t) => {
	const provider = new AgentsProvider(
		() => ({ cwd: process.cwd(), sessionId: undefined, sessionFile: undefined }),
		new AgentRunRegistry(),
		() => ({ timeoutMs: 1000, waitMs: 0 }),
	);
	t.after(() => provider.close());
	const descriptor = await provider.describe("run", {} as never);
	assert.ok(descriptor);
	const tool = createActionTool(provider, descriptor);
	let codemode: ToolDefinition<any, any> | undefined;
	createCodemodeExtension({ models: false })({
		registerTool: (definition: ToolDefinition<any, any>) => {
			codemode = definition;
		},
		getAllTools: () => [tool],
		getSettings: () => ({}),
		appendEntry: () => {},
	} as unknown as ExtensionAPI);
	assert.ok(codemode);
	const result = await codemode.execute(
		"schema-test",
		{ code: 'return await describeTool("agents_run");' },
		undefined,
		undefined,
		{ cwd: process.cwd(), tools: [tool], sessionManager: { getBranch: () => [] } } as never,
	);
	assert.notEqual(result.isError, true);
	const text = result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
	assert.match(text, /runId/);
	assert.match(text, /state:\s*"running"/);
	assert.match(text, /state:\s*"done"/);
	assert.match(text, /state:\s*"failed"/);
});
