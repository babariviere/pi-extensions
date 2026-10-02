/** Minimal native extension host for focused lifecycle tests. */
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Handler = (event: any, ctx: ExtensionContext) => unknown;

export function testHost() {
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, ToolDefinition<any, any>>();
	const flags = new Map<string, unknown>();
	const sent: Array<{ message: any; options: any }> = [];
	const users: string[] = [];
	const widgets: Array<unknown> = [];
	const listeners = new Map<string, Set<(value: unknown) => void>>();
	let idle = true;
	const ctx = {
		cwd: process.cwd(),
		mode: "print",
		hasUI: false,
		scopedModels: [],
		isProjectTrusted: () => false,
		isIdle: () => idle,
		modelRegistry: { getAvailable: async () => [] },
		sessionManager: {
			getSessionId: () => "session",
			getSessionFile: () =>
				process.env.PI_CODING_AGENT_DIR ? join(process.env.PI_CODING_AGENT_DIR, "parent.jsonl") : undefined,
		},
		ui: { setWidget: (_key: string, widget: unknown) => widgets.push(widget) },
	} as unknown as ExtensionContext;
	const api = {
		on: (event: string, handler: Handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		registerTool: (tool: ToolDefinition<any, any>) => tools.set(tool.name, tool),
		registerFlag: (name: string, options: { default?: unknown }) => {
			if (!flags.has(name)) flags.set(name, options.default);
		},
		getFlag: (name: string) => flags.get(name),
		sendMessage: (message: unknown, options: unknown) => sent.push({ message, options }),
		sendUserMessage: (message: string) => users.push(message),
		events: {
			on: (name: string, fn: (value: unknown) => void) => {
				let list = listeners.get(name);
				if (!list) listeners.set(name, (list = new Set()));
				list.add(fn);
				return () => list.delete(fn);
			},
			emit: (name: string, value: unknown) => {
				for (const fn of listeners.get(name) ?? []) fn(value);
			},
		},
	} as unknown as ExtensionAPI;
	return {
		api,
		ctx,
		tools,
		flags,
		sent,
		users,
		widgets,
		setIdle: (value: boolean) => {
			idle = value;
		},
		async emit(name: string, event: unknown = {}) {
			const results = [];
			for (const handler of handlers.get(name) ?? []) results.push(await handler(event, ctx));
			return results;
		},
		async execute(name: string, args: Record<string, unknown>) {
			const tool = tools.get(name);
			if (!tool || tool.exposure === "hidden") throw new Error(`Unavailable tool ${name}`);
			return tool.execute("call", args, undefined, undefined, ctx as never);
		},
	};
}

export async function withParentSession(run: () => Promise<void>): Promise<void> {
	const before = {
		subagent: process.env.PI_CODE_MODE_SUBAGENT,
		background: process.env.PI_BACKGROUND_AGENT_ATTEMPT,
		agentDir: process.env.PI_CODING_AGENT_DIR,
	};
	const agentDir = mkdtempSync(join(tmpdir(), "native-extension-host-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.PI_CODE_MODE_SUBAGENT;
	delete process.env.PI_BACKGROUND_AGENT_ATTEMPT;
	try {
		await run();
	} finally {
		if (before.subagent === undefined) delete process.env.PI_CODE_MODE_SUBAGENT;
		else process.env.PI_CODE_MODE_SUBAGENT = before.subagent;
		if (before.background === undefined) delete process.env.PI_BACKGROUND_AGENT_ATTEMPT;
		else process.env.PI_BACKGROUND_AGENT_ATTEMPT = before.background;
		if (before.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = before.agentDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
}
