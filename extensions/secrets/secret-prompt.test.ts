import assert from "node:assert/strict";
import { test } from "node:test";
import { updateSecretPromptSection } from "./secret-prompt.ts";

test("secret prompt is a named section containing names, not values", () => {
	const sections: Record<string, string> = { preamble: "Base" };
	updateSecretPromptSection(sections, [{ name: "TOKEN", value: "private-secret-value" }]);
	assert.equal(sections.preamble, "Base");
	assert.match(sections.secrets, /Available secrets .* TOKEN/);
	assert.match(sections.secrets, /Never ask the user for secret values/);
	assert.doesNotMatch(sections.secrets, /private-secret-value/);
});

test("secret prompt removes its stale section when no secrets are available", () => {
	const sections: Record<string, string> = { preamble: "Base", secrets: "stale names" };
	updateSecretPromptSection(sections, []);
	assert.deepEqual(sections, { preamble: "Base" });
});
