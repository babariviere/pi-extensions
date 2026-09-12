import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	CODE_MODE_PROVIDER_DISCOVER_EVENT,
	CODE_MODE_PROVIDER_REGISTER_EVENT,
	type CodeModeProviderDiscovery,
	type CodeModeProviderRegistration,
} from "../code-mode/protocol.ts";
import nightMode from "./index.ts";
import { answerNightModePlanningQuery, NIGHT_MODE_PLANNING_QUERY_EVENT } from "./protocol.ts";

describe("night Code Mode provider", () => {
	it("registers and supports late discovery without exposing a native tool", async () => {
		const listeners = new Map<string, (value: unknown) => void>();
		const emissions = new Map<string, unknown>();
		let nativeTools = 0;
		const pi = {
			on() {},
			events: {
				on: (name: string, handler: (value: unknown) => void) => {
					listeners.set(name, handler);
					return () => listeners.delete(name);
				},
				emit: (name: string, value: unknown) => emissions.set(name, value),
			},
			registerTool: () => nativeTools++,
			registerCommand() {},
		} as unknown as ExtensionAPI;

		nightMode(pi);

		assert.equal(nativeTools, 0);
		const registration = emissions.get(CODE_MODE_PROVIDER_REGISTER_EVENT) as CodeModeProviderRegistration;
		assert.equal(registration.version, 1);
		assert.equal(registration.provider.name, "night");
		assert.equal(registration.overwrite, true);
		const descriptor = await registration.provider.describe("plan", {} as never);
		assert.equal(descriptor?.name, "plan");
		assert.equal((descriptor?.inputSchema.properties as Record<string, unknown>).tasks !== undefined, true);
		await assert.rejects(() => registration.provider.invoke("plan", { tasks: [] }, {} as never), /No night planning/);

		let discovered = "";
		listeners.get(CODE_MODE_PROVIDER_DISCOVER_EVENT)?.({
			version: 1,
			register: (provider, options) => {
				discovered = `${provider.name}:${String(options?.overwrite)}`;
			},
		} satisfies CodeModeProviderDiscovery);
		assert.equal(discovered, "night:true");
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
		const listeners = new Map<string, (value: unknown) => void>();
		nightMode({
			on() {},
			events: {
				on: (name: string, handler: (value: unknown) => void) => {
					listeners.set(name, handler);
					return () => listeners.delete(name);
				},
				emit() {},
			},
			registerCommand() {},
		} as unknown as ExtensionAPI);
		const query = { version: 1 as const, planning: true };
		listeners.get(NIGHT_MODE_PLANNING_QUERY_EVENT)?.(query);
		assert.equal(query.planning, false);
	});
});
