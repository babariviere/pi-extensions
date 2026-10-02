import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	latestRoutedPhysicalModel,
	routedPhysicalModelFromMessage,
	sameRoutedModel,
	type RoutedPhysicalModel,
} from "./routed-model.ts";

function assistant(
	model: string,
	stopReason: string,
	options: { provider?: string; thinkingLevel?: string; responseModel?: string } = {},
): SessionEntry {
	return {
		type: "message",
		id: model,
		parentId: null,
		timestamp: new Date(0).toISOString(),
		message: {
			role: "assistant",
			provider: options.provider ?? "openai-codex",
			model,
			responseModel: options.responseModel,
			thinkingLevel: options.thinkingLevel,
			stopReason,
		} as never,
	} as SessionEntry;
}

test("extracts the concrete physical response model and its thinking level", () => {
	assert.deepEqual(
		routedPhysicalModelFromMessage({
			role: "assistant",
			provider: "anthropic",
			model: "claude-alias",
			responseModel: "claude-sonnet-4-5",
			thinkingLevel: "high",
			stopReason: "stop",
		}),
		{ provider: "anthropic", id: "claude-sonnet-4-5", thinkingLevel: "high" },
	);
	assert.deepEqual(
		routedPhysicalModelFromMessage({
			role: "assistant",
			provider: "openai-codex",
			model: "gpt-5-codex",
			providerThinkingLevel: "medium",
			stopReason: "toolUse",
		}),
		{ provider: "openai-codex", id: "gpt-5-codex", thinkingLevel: "medium" },
	);
});

test("ignores incomplete, failed, non-assistant, and unidentifiable responses", () => {
	for (const stopReason of ["pending", "deferred", "aborted", "error"]) {
		assert.equal(
			routedPhysicalModelFromMessage({ role: "assistant", provider: "p", model: "m", stopReason }),
			undefined,
		);
	}
	assert.equal(
		routedPhysicalModelFromMessage({ role: "user", provider: "p", model: "m", stopReason: "stop" }),
		undefined,
	);
	assert.equal(routedPhysicalModelFromMessage({ role: "assistant", provider: "p", stopReason: "stop" }), undefined);
	assert.equal(
		routedPhysicalModelFromMessage({
			role: "assistant",
			api: "pi-virtual",
			provider: "router",
			model: "auto",
			stopReason: "stop",
		}),
		undefined,
	);
});

test("finds the latest successful response only on the active branch", () => {
	const prior = assistant("gpt-4", "stop", { thinkingLevel: "low" });
	const failed = assistant("claude-opus", "error", { provider: "anthropic", thinkingLevel: "high" });
	const routed = assistant("claude-sonnet", "stop", { provider: "anthropic", thinkingLevel: "medium" });
	const otherBranch = [assistant("gpt-5", "stop")];

	assert.deepEqual(latestRoutedPhysicalModel([prior, failed]), {
		provider: "openai-codex",
		id: "gpt-4",
		thinkingLevel: "low",
	});
	assert.deepEqual(latestRoutedPhysicalModel([prior, routed]), {
		provider: "anthropic",
		id: "claude-sonnet",
		thinkingLevel: "medium",
	});
	assert.deepEqual(latestRoutedPhysicalModel(otherBranch), { provider: "openai-codex", id: "gpt-5" });
});

test("compares physical identity independently of thinking", () => {
	const routed: RoutedPhysicalModel = { provider: "p", id: "m", thinkingLevel: "low" };
	assert.equal(sameRoutedModel(routed, { provider: "p", id: "m" }), true);
	assert.equal(sameRoutedModel({ provider: "p", id: "m" }, { provider: "q", id: "m" }), false);
	assert.equal(sameRoutedModel(undefined, { provider: "p", id: "m" }), false);
});
