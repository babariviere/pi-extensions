import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { inheritedParentModel } from "./parent-model.ts";

function context(model: unknown, messages: unknown[] = []): Pick<ExtensionContext, "model" | "sessionManager"> {
	return {
		model,
		sessionManager: { getBranch: () => messages.map((message) => ({ type: "message", message })) },
	} as never;
}
const virtual = { provider: "router", id: "auto", api: "pi-virtual" };
const physical = { provider: "openai-codex", id: "catalog-model", api: "openai-codex-responses" };

test("physical selection remains the child default regardless of prior branch responses", () => {
	assert.equal(inheritedParentModel(context(physical)), physical);
});

test("virtual parents inherit the latest successful dispatched catalog model, not response aliases", () => {
	assert.deepEqual(
		inheritedParentModel(
			context(virtual, [
				{ role: "assistant", provider: "anthropic", model: "old", stopReason: "stop" },
				{
					role: "assistant",
					provider: physical.provider,
					model: physical.id,
					responseModel: "upstream-alias",
					stopReason: "toolUse",
				},
				{ role: "assistant", provider: "other", model: "failed", stopReason: "error" },
			]),
		),
		{ provider: physical.provider, id: physical.id },
	);
});

test("virtual selection without a successful physical response is not inherited by a child", () => {
	assert.equal(inheritedParentModel(context(virtual)), undefined);
	assert.equal(
		inheritedParentModel(
			context(virtual, [{ role: "assistant", provider: "test", model: "cancelled", stopReason: "aborted" }]),
		),
		undefined,
	);
});
