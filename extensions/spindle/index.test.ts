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
		assert.match(
			guidance,
			/Manual file edits must use `pi\.edit\(\{ path, edits: \[\{ oldText, newText \}\] \}\)`, `pi\.write`, or `pi\.applyPatch\(\{ patch: π\.patch \}\)`\./,
		);
	});
}

test("full-code guidance keeps sandboxed edit and automation constraints", () => {
	assert.match(FULL_CODE_GUIDANCE, /Pass V4A patch text through `payloads`, not an inline string\./);
	assert.match(FULL_CODE_GUIDANCE, /If `pi\.edit` fails, reread the target file and retry with updated exact text\./);
	assert.match(
		FULL_CODE_GUIDANCE,
		/Do not use `python`, `sed`, `perl`, `awk`, `cat`, `tee`, or shell redirection for manual edits\./,
	);
	assert.match(FULL_CODE_GUIDANCE, /Formatters, generators, migrations, builds, and tests are allowed\./);
});
