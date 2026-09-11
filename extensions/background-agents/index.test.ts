import assert from "node:assert/strict";
import { test } from "node:test";
import { isBackgroundWorkerSession } from "./client.ts";
import backgroundAgentsExtension, { shouldOpenBackgroundDashboard } from "./index.ts";

test("opens only for interactive operator startup sessions", () => {
	assert.equal(shouldOpenBackgroundDashboard("startup", "tui", {}), true);
	assert.equal(shouldOpenBackgroundDashboard("startup", "print", {}), false);
	assert.equal(shouldOpenBackgroundDashboard("reload", "tui", {}), false);
	assert.equal(shouldOpenBackgroundDashboard("startup", "tui", { PI_BACKGROUND_AGENT_ATTEMPT: "1" }), false);
	assert.equal(isBackgroundWorkerSession({ PI_BACKGROUND_AGENT_ATTEMPT: "1" }), true);
});

test("registers the background command without importing controller code", () => {
	const commands: string[] = [];
	const events: string[] = [];
	const pi = {
		registerCommand(name: string) {
			commands.push(name);
		},
		on(name: string) {
			events.push(name);
		},
	} as never;
	backgroundAgentsExtension(pi);
	assert.deepEqual(commands, ["background"]);
	assert.deepEqual(events, ["session_start", "session_shutdown"]);
});

test("defers the default dashboard so session_start returns immediately", async () => {
	let sessionStart: ((event: { reason: string }, ctx: never) => void) | undefined;
	let customStarted = false;
	const pi = {
		registerCommand() {},
		on(name: string, handler: (event: { reason: string }, ctx: never) => void) {
			if (name === "session_start") sessionStart = handler;
		},
	} as never;
	backgroundAgentsExtension(pi);
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			custom: async () => {
				customStarted = true;
				return undefined;
			},
		},
	} as never;
	sessionStart!({ reason: "startup" }, ctx);
	assert.equal(customStarted, false);
	await Promise.resolve();
	assert.equal(customStarted, false);
});
