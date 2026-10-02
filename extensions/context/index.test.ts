import assert from "node:assert/strict";
import { test } from "node:test";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import contextExtension, { getLoadedSkillsFromSession } from "./index.ts";

test("loaded-skill state follows the current branch rather than every session entry", () => {
	const branch = [
		{ type: "custom", customType: "context:skill_loaded", data: { name: "active", path: "/skills/active/SKILL.md" } },
	];
	const allEntries = [
		...branch,
		{ type: "custom", customType: "context:skill_loaded", data: { name: "abandoned", path: "/skills/old/SKILL.md" } },
	];
	const ctx = {
		sessionManager: {
			getBranch: () => branch,
			getEntries: () => allEntries,
		},
	} as unknown as ExtensionContext;

	assert.deepEqual([...getLoadedSkillsFromSession(ctx)], ["active"]);
});

test("successful SDK read-tool results mark skills loaded on the active branch", () => {
	const entries: Array<Record<string, unknown>> = [];
	let onToolResult: ((event: ToolResultEvent, ctx: ExtensionContext) => unknown) | undefined;
	const api = {
		getCommands: () => [
			{
				source: "skill",
				name: "example",
				sourceInfo: { path: "/repo/skills/example/SKILL.md" },
			},
		],
		registerCommand: () => {},
		on: (name: string, handler: (event: ToolResultEvent, ctx: ExtensionContext) => unknown) => {
			if (name === "tool_result") onToolResult = handler;
		},
		appendEntry: (customType: string, data: unknown) => {
			entries.push({ type: "custom", customType, data });
		},
	} as unknown as ExtensionAPI;
	contextExtension(api);
	const ctx = {
		cwd: "/repo",
		sessionManager: {
			getSessionId: () => "session",
			getBranch: () => entries,
		},
	} as unknown as ExtensionContext;
	const event = {
		type: "tool_result",
		toolCallId: "read-1",
		toolName: "read",
		input: { path: "skills/example/SKILL.md" },
		content: [],
		isError: false,
		details: undefined,
	};

	assert.ok(onToolResult);
	onToolResult(event as unknown as ToolResultEvent, ctx);
	assert.equal(entries.length, 1);
	assert.deepEqual([...getLoadedSkillsFromSession(ctx)], ["example"]);
	assert.equal(entries[0]?.customType, "context:skill_loaded");
});

test("RPC context command uses plain text even when the client has UI support", async () => {
	type Command = {
		handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
	};
	const messages: Array<{ content: string; options?: { triggerTurn?: boolean } }> = [];
	let command: Command | undefined;
	let customCalls = 0;
	let contextWindow = 200;
	const api = {
		getCommands: () => [],
		on: () => {},
		registerCommand: (_name: string, definition: Command) => {
			command = definition;
		},
		sendMessage: (message: { content: string }, options?: { triggerTurn?: boolean }) =>
			messages.push({ ...message, options }),
		appendEntry: () => {},
	} as unknown as ExtensionAPI;
	contextExtension(api);
	const ctx = {
		getSystemPromptOptions: () => ({
			contextFiles: [{ path: "/repo/project/AGENTS.md", content: "instructions that really loaded" }],
			skills: [{ name: "project-skill" }],
		}),
		mode: "rpc",
		hasUI: true,
		cwd: "/repo/project",
		sessionManager: {
			getSessionId: () => "session",
			getBranch: () => [],
			getEntries: () => [
				{
					type: "message",
					message: { role: "toolResult", toolName: "read", usage: { input: 5, output: 2, cost: { total: 0.25 } } },
				},
				{
					type: "usage",
					kind: "arbitrary",
					provider: "provider",
					model: "model",
					usage: { input: 3 },
				},
			],
		},
		getSystemPrompt: () => "system prompt",
		getContextUsage: () => ({ tokens: 100, contextWindow, percent: contextWindow ? 50 : null }),
		ui: {
			custom: async () => {
				customCalls++;
			},
		},
	} as unknown as ExtensionCommandContext;

	assert.ok(command);
	await command.handler("", ctx);
	assert.equal(customCalls, 0);
	assert.equal(messages.length, 1);
	assert.equal(messages[0]?.options?.triggerTurn, false);
	assert.match(messages[0]?.content ?? "", /Window: ~100 \/ 200/);
	assert.match(messages[0]?.content ?? "", /Tools\/loadout: included in window total/);
	assert.match(messages[0]?.content ?? "", /AGENTS: \.\/AGENTS\.md/);
	assert.match(messages[0]?.content ?? "", /Skills \(1\): project-skill/);
	assert.match(messages[0]?.content ?? "", /Session: 10 tokens/);
	assert.match(messages[0]?.content ?? "", /\$0\.250/);

	contextWindow = 0;
	await command.handler("", ctx);
	assert.match(messages[1]?.content ?? "", /Window: ~100 \/ 0/);
	assert.doesNotMatch(messages[1]?.content ?? "", /undefined|null|% used/);
});
