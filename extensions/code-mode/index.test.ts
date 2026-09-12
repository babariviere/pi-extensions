import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { FULL_CODE_GUIDANCE, resolveSpindleEditGuidance, type SpindleModelIdentity } from "./index.ts";

const editGuidanceCases: {
	name: string;
	model: SpindleModelIdentity | undefined;
	expected: RegExp;
}[] = [
	{
		name: "OpenAI provider",
		model: { provider: "openai", api: "custom", id: "o3" },
		expected: /Prefer `pi\.applyPatch`; use `pi\.edit` or `pi\.write` as fallback\./,
	},
	{
		name: "Codex API",
		model: { provider: "proxy", api: "openai-codex-responses", id: "deployment" },
		expected: /Prefer `pi\.applyPatch`; use `pi\.edit` or `pi\.write` as fallback\./,
	},
	{
		name: "GPT model id",
		model: { provider: "openrouter", api: "custom", id: "openai/gpt-5.4" },
		expected: /Prefer `pi\.applyPatch`; use `pi\.edit` or `pi\.write` as fallback\./,
	},
	{
		name: "Anthropic provider",
		model: { provider: "anthropic", api: "custom", id: "deployment" },
		expected: /Prefer `pi\.edit`; use `pi\.applyPatch` for coordinated multi-file changes\./,
	},
	{
		name: "Anthropic API",
		model: { provider: "proxy", api: "anthropic-messages", id: "deployment" },
		expected: /Prefer `pi\.edit`; use `pi\.applyPatch` for coordinated multi-file changes\./,
	},
	{
		name: "Claude model id takes precedence over an OpenAI-compatible API",
		model: { provider: "openrouter", api: "openai-completions", id: "anthropic/claude-sonnet-4" },
		expected: /Prefer `pi\.edit`; use `pi\.applyPatch` for coordinated multi-file changes\./,
	},
	{
		name: "neutral fallback",
		model: { provider: "google", api: "google-generative-ai", id: "gemini-2.5-pro" },
		expected: /Prefer `pi\.edit` or `pi\.write`; use `pi\.applyPatch` for multi-file V4A input\./,
	},
	{
		name: "missing model",
		model: undefined,
		expected: /Prefer `pi\.edit` or `pi\.write`; use `pi\.applyPatch` for multi-file V4A input\./,
	},
];

for (const { name, model, expected } of editGuidanceCases) {
	test(`edit guidance resolves the ${name} profile`, () => {
		const guidance = resolveSpindleEditGuidance(model);
		assert.match(guidance, expected);
		assert.ok(guidance.length < 100);
	});
}

test("full-code guidance bootstraps the skill without duplicating its workflow", () => {
	assert.match(FULL_CODE_GUIDANCE, /Pi core tools and registered capabilities/);
	assert.match(FULL_CODE_GUIDANCE, /Other extensions keep their native tools/);
	assert.match(FULL_CODE_GUIDANCE, /do not use Python as a fallback/);
	assert.match(FULL_CODE_GUIDANCE, /If the `code-mode` skill is available/);
	assert.match(FULL_CODE_GUIDANCE, /SKILL\.md through `pi\.read` inside `code_mode`/);
	assert.match(FULL_CODE_GUIDANCE, /before other tool work, unless already loaded/);
	assert.ok(FULL_CODE_GUIDANCE.includes(resolveSpindleEditGuidance(undefined)));
	assert.doesNotMatch(FULL_CODE_GUIDANCE, /Search with|Read targeted|File changes use|payloads|reread and retry/);
	assert.ok(Buffer.byteLength(FULL_CODE_GUIDANCE, "utf8") <= 500);
});

test("the bundled skill owns static file guidance and portable reference links", () => {
	const skillUrl = new URL("../../skills/code-mode/SKILL.md", import.meta.url);
	const skill = readFileSync(skillUrl, "utf8");
	const reference = readFileSync(new URL("references/full-reference.md", skillUrl), "utf8");
	assert.match(skill, /pi\.find.*pi\.grep.*pi\.ls/);
	assert.match(skill, /pi\.read\(\{ path, offset, limit \}\)/);
	assert.match(skill, /Never manually edit through Python, shell text utilities, or redirection/);
	assert.match(skill, /formatters, generators, migrations, builds, and tests are allowed/);
	assert.match(reference, /pi\.edit\(\{ path, edits: \[\{ oldText, newText \}\] \}\)/);
	assert.match(reference, /pi\.applyPatch\(\{ patch: π\.patch \}\)/);
	assert.match(reference, /Put V4A and other multiline content in `payloads`/);
	assert.match(reference, /If `pi\.edit` misses, reread/);
	assert.doesNotMatch(reference, /^---\nname:/);
	for (const [, link] of skill.matchAll(/\]\((references\/[^)]+)\)/g)) {
		const target = new URL(link, skillUrl);
		assert.ok(readFileSync(target, "utf8").length > 0, link);
	}
});
