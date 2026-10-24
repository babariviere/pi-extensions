import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import nightMode from "./index.ts";
import { USAGE_SNAPSHOT_EVENT } from "../usage/protocol.ts";

/**
 * The budget guard follows the model the session runs on.
 *
 * A session on Claude is stopped by the Claude limit, a session on Codex by the
 * Codex limit, and a session on a model with no subscription windows is never
 * stopped by a limit that belongs to another provider.
 */

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

interface SelectedModel {
	provider: string;
	id: string;
}

function createHarness(selected: SelectedModel) {
	const handlers = new Map<string, Handler[]>();
	const listeners = new Map<string, Array<(value: unknown) => void>>();
	const notifications: string[] = [];
	const messages: string[] = [];
	const entries: Array<{ customType?: string; data?: unknown }> = [];

	const pi = {
		on: (name: string, handler: Handler) => {
			const current = handlers.get(name) ?? [];
			current.push(handler);
			handlers.set(name, current);
		},
		events: {
			on: (name: string, handler: (value: unknown) => void) => {
				const current = listeners.get(name) ?? [];
				current.push(handler);
				listeners.set(name, current);
				return () =>
					listeners.set(
						name,
						(listeners.get(name) ?? []).filter((candidate) => candidate !== handler),
					);
			},
			emit: (name: string, value: unknown) => {
				for (const listener of listeners.get(name) ?? []) listener(value);
			},
		},
		registerTool() {},
		registerCommand() {},
		appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
		sendUserMessage: (message: string) => messages.push(message),
		setModel: async () => true,
	} as unknown as ExtensionAPI;

	const ctx = {
		cwd: process.cwd(),
		model: selected,
		mode: "tui",
		hasUI: true,
		isIdle: () => true,
		sessionManager: {
			getEntries: () => entries,
			getBranch: () => [],
			getSessionId: () => "guard-test",
		},
		ui: {
			notify: (message: string) => notifications.push(message),
			setStatus() {},
		},
	} as unknown as ExtensionContext;

	nightMode(pi);

	return {
		emit: async (name: string, event: unknown = {}): Promise<void> => {
			for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
		},
		emitUsage: (snapshot: unknown): void => {
			pi.events.emit(USAGE_SNAPSHOT_EVENT, { fetchedAt: Date.now(), snapshot });
		},
		toolCall: async (): Promise<{ block?: boolean; terminate?: boolean; reason?: string } | undefined> => {
			let result: { block?: boolean; terminate?: boolean; reason?: string } | undefined;
			for (const handler of handlers.get("tool_call") ?? []) {
				result = (await handler({}, ctx)) as typeof result;
			}
			return result;
		},
		entries,
		messages,
		notifications,
	};
}

const CLAUDE = { provider: "anthropic", id: "claude-sonnet-4-5" };
const CODEX = { provider: "openai-codex", id: "gpt-5.6-luna" };
const OTHER = { provider: "minimax", id: "minimax-m2" };

function claudeSnapshot(percent: number): unknown {
	return {
		provider: "anthropic",
		windows: [
			{ label: "5h", usedPercent: percent, resetsAt: new Date(Date.now() + 60 * 60_000).toISOString() },
			{ label: "Week", usedPercent: 1 },
		],
	};
}

function codexSnapshot(percent: number): unknown {
	return {
		provider: "openai",
		windows: [
			{ label: "5h", usedPercent: percent, resetsAt: new Date(Date.now() + 60 * 60_000).toISOString() },
			{ label: "Week", usedPercent: 1 },
		],
	};
}

test("a Claude limit blocks a session that runs on Claude", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: new Date(2026, 7, 29, 22).getTime() });
	const harness = createHarness(CLAUDE);
	await harness.emit("session_start");
	harness.emitUsage(claudeSnapshot(99));

	const blocked = await harness.toolCall();
	assert.equal(blocked?.block, true);
	assert.match(String(blocked?.reason), /Claude 5h usage window at 99%/);
	await harness.emit("session_shutdown");
});

test("a Codex limit blocks a session that runs on Codex", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: new Date(2026, 7, 29, 22).getTime() });
	const harness = createHarness(CODEX);
	await harness.emit("session_start");
	harness.emitUsage(codexSnapshot(99));

	const blocked = await harness.toolCall();
	assert.equal(blocked?.block, true);
	assert.match(String(blocked?.reason), /Codex 5h usage window at 99%/);
	await harness.emit("session_shutdown");
});

test("a Claude limit does not block a session that runs on another provider", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: new Date(2026, 7, 29, 22).getTime() });
	const harness = createHarness(OTHER);
	await harness.emit("session_start");
	harness.emitUsage(claudeSnapshot(99));

	const blocked = await harness.toolCall();
	assert.equal(blocked, undefined, "a limit that belongs to another provider does not stop this run");
	assert.ok(
		harness.notifications.every((message) => !message.includes("pausing")),
		"the run is not paused either",
	);
	await harness.emit("session_shutdown");
});

test("a Codex limit does not block a session that runs on Claude", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: new Date(2026, 7, 29, 22).getTime() });
	const harness = createHarness(CLAUDE);
	await harness.emit("session_start");
	harness.emitUsage(codexSnapshot(99));

	const blocked = await harness.toolCall();
	assert.equal(blocked, undefined);
	await harness.emit("session_shutdown");
});

test("moving to another model lifts the pause the old provider caused", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: new Date(2026, 7, 29, 22).getTime() });
	const harness = createHarness(CLAUDE);
	await harness.emit("session_start");
	harness.emitUsage(claudeSnapshot(99));
	assert.equal((await harness.toolCall())?.block, true);

	await harness.emit("model_select", { model: CODEX });

	assert.equal(await harness.toolCall(), undefined, "the Claude limit no longer stops a Codex session");
	assert.equal(harness.messages.length, 1, "the run is told to continue");
	assert.match(harness.messages[0], /moved off Claude/);
	await harness.emit("session_shutdown");
});
