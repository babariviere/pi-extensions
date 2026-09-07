import assert from "node:assert/strict";
import { it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import nightMode from "./index.ts";
import { NIGHT_PLAN_HANDOFF_ENTRY } from "./plan.ts";

type Entry = { customType: string; data: unknown };
function harness(entries: Entry[]) {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	let command: (args: string, ctx: ExtensionContext) => Promise<void>;
	let modelLookups = 0;
	const notifications: string[] = [];
	const pi = {
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, handler),
		events: { on: () => () => {}, emit() {} },
		registerTool() {},
		registerCommand: (_name: string, value: { handler: typeof command }) => {
			command = value.handler;
		},
		appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
	} as unknown as ExtensionAPI;
	const ctx = {
		isIdle: () => true,
		sessionManager: { getEntries: () => entries },
		modelRegistry: {
			find: () => {
				modelLookups++;
				return undefined;
			},
		},
		ui: { notify: (text: string) => notifications.push(text), setStatus() {} },
	} as unknown as ExtensionContext;
	nightMode(pi);
	return {
		event: async (name: string) => {
			await handlers.get(name)?.({}, ctx);
		},
		off: () => command("off", ctx),
		lookups: () => modelLookups,
		notifications,
	};
}
function approved(at: number): Entry[] {
	return [
		{
			customType: NIGHT_PLAN_HANDOFF_ENTRY,
			data: {
				version: 1,
				planningStartedAt: 1,
				scheduledStartAt: at,
				tasks: [{ title: "Read only" }],
			},
		},
	];
}

it("restores the original schedule and attempts no execution before the deadline", async (t) => {
	const at = new Date(2026, 7, 29, 21).getTime();
	t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: at - 1000 });
	const entries = approved(at);
	const first = harness(entries);
	await first.event("session_start");
	assert.equal(first.lookups(), 0);
	assert.match(first.notifications[0], /scheduled for/);
	await first.event("session_shutdown");
	const restored = harness(entries);
	await restored.event("session_start");
	t.mock.timers.tick(999);
	assert.equal(restored.lookups(), 0);
	t.mock.timers.tick(1);
	await Promise.resolve();
	assert.equal(restored.lookups(), 1);
	// Model failure must not consume the persisted handoff.
	assert.equal(entries.length, 1);
	await restored.event("session_shutdown");
});

it("starts an overdue restored schedule without rolling it forward", async (t) => {
	const at = new Date(2026, 7, 29, 21).getTime();
	t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: at + 12 * 3600000 });
	const run = harness(approved(at));
	await run.event("session_start");
	assert.equal(run.lookups(), 1);
	await run.event("session_shutdown");
});

it("off cancels the timer and persists cancellation across reload", async (t) => {
	const at = new Date(2026, 7, 29, 21).getTime();
	t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: at - 1000 });
	const entries = approved(at);
	const run = harness(entries);
	await run.event("session_start");
	await run.off();
	t.mock.timers.tick(1000);
	assert.equal(run.lookups(), 0);
	await run.event("session_shutdown");
	const restored = harness(entries);
	await restored.event("session_start");
	assert.equal(restored.lookups(), 0);
	await restored.event("session_shutdown");
});
