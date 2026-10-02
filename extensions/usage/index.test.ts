import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import usage, { UsageModelTracker } from "./index.ts";
import { usageProviderForModel } from "./protocol.ts";

test("usage is informational and no longer registers a tool guard or pacing commands", async () => {
	const events: string[] = [];
	let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
	usage({
		events: { on: () => {} },
		on: (event: string) => {
			events.push(event);
		},
		registerCommand: (_name: string, options: typeof command) => {
			command = options;
		},
	} as unknown as ExtensionAPI);

	assert.equal(events.includes("tool_call"), false);
	assert.deepEqual(command?.getArgumentCompletions?.("pacing"), []);
	assert.deepEqual(command?.getArgumentCompletions?.("sta"), [{ value: "status", label: "status" }]);
	const notices: Array<[string, string]> = [];
	await command?.handler("pacing off", {
		ui: { notify: (message: string, level: string) => notices.push([message, level]) },
	} as unknown as Parameters<NonNullable<typeof command>["handler"]>[1]);
	assert.deepEqual(notices, [["usage: unknown action (use /usage status)", "warning"]]);
});

function assistant(provider: string, model: string, stopReason: string, thinkingLevel = "medium"): SessionEntry {
	return {
		type: "message",
		id: `${provider}-${model}`,
		parentId: null,
		timestamp: new Date(0).toISOString(),
		message: {
			role: "assistant",
			provider,
			model,
			stopReason,
			thinkingLevel,
		} as never,
	} as SessionEntry;
}

test("usage provider follows physical responses across model, branch, and session switches", () => {
	const tracker = new UsageModelTracker();
	const router = { provider: "router", id: "auto", api: "pi-virtual" };
	const selectedClaude = { provider: "anthropic", id: "claude-sonnet-4-5" };

	tracker.startSession(router, [assistant("openai-codex", "gpt-5-codex", "stop", "high")]);
	assert.equal(usageProviderForModel(tracker.currentModel), "openai");

	tracker.selectModel(selectedClaude);
	assert.equal(
		usageProviderForModel(tracker.currentModel),
		"anthropic",
		"ordinary model switches keep their existing immediate provider selection",
	);
	tracker.selectModel(router);
	assert.equal(
		tracker.messageEnded({
			role: "assistant",
			provider: "anthropic",
			model: "claude-opus-4-5",
			stopReason: "error",
		}),
		false,
	);
	assert.equal(
		usageProviderForModel(tracker.currentModel),
		"openai",
		"failed requests do not change the usage source",
	);
	assert.equal(
		tracker.messageEnded({
			role: "assistant",
			provider: "anthropic",
			model: "claude-opus-4-5",
			stopReason: "stop",
		}),
		true,
	);
	assert.equal(usageProviderForModel(tracker.currentModel), "anthropic");
	tracker.selectModel({ provider: "openai-codex", id: "gpt-5-codex" });
	assert.equal(
		usageProviderForModel(tracker.currentModel),
		"openai",
		"physical history must not override an explicit physical selection",
	);

	tracker.changeBranch(router, [assistant("openai-codex", "gpt-5.6-luna", "toolUse", "low")]);
	assert.equal(
		usageProviderForModel(tracker.currentModel),
		"openai",
		"branch navigation reconstructs the route from that branch",
	);

	tracker.startSession(selectedClaude, []);
	assert.equal(usageProviderForModel(tracker.currentModel), "anthropic", "a new session falls back to its selection");
});
