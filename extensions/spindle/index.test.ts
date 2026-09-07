import assert from "node:assert/strict";
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

test("full-code guidance identifies concise TypeScript code mode constraints", () => {
	assert.match(FULL_CODE_GUIDANCE, /TypeScript code mode and exclusive tool interface/);
	assert.match(FULL_CODE_GUIDANCE, /do not use Python as a fallback/);
	assert.match(
		FULL_CODE_GUIDANCE,
		/File changes use `pi\.edit\(\{ path, edits: \[\{ oldText, newText \}\] \}\)`, `pi\.write`, or `pi\.applyPatch\(\{ patch: π\.patch \}\)`\./,
	);
	assert.match(FULL_CODE_GUIDANCE, /Put V4A and other multiline content in `payloads`\./);
	assert.match(FULL_CODE_GUIDANCE, /If `pi\.edit` misses, reread and retry\./);
	assert.match(FULL_CODE_GUIDANCE, /Never manually edit through Python, shell text utilities, or redirection/);
	assert.match(FULL_CODE_GUIDANCE, /formatters, generators, migrations, builds, and tests are allowed/);
	assert.ok(Buffer.byteLength(FULL_CODE_GUIDANCE, "utf8") <= 1_000);
});
