import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { applySecretPolicy } from "./secret-policy.ts";
import { SecretRefRegistry } from "./secret-ref.ts";

const KEY = "a".repeat(64);
const GH = `ghp_${"a".repeat(36)}`;

function setup() {
	const registry = new SecretRefRegistry(KEY);
	const named = registry.registerNamed("GITHUB_TOKEN", GH);
	const detected = registry.register(`ghp_${"b".repeat(36)}`, { label: "github-token" });
	return { registry, named, detected };
}

function event(toolName: string, input: Record<string, unknown>): ToolCallEvent {
	return { type: "tool_call", toolCallId: "call-1", toolName, input } as ToolCallEvent;
}

test("write expands a ref and reports what it materialized", () => {
	const { registry, named } = setup();
	const call = event("write", { path: ".env", content: `GITHUB_TOKEN=${named.ref}\n` });
	const outcome = applySecretPolicy(call, registry);
	assert.equal(outcome.block, false);
	assert.equal((call.input as { content: string }).content, `GITHUB_TOKEN=${GH}\n`);
	assert.match(String(outcome.block === false && outcome.notify), /GITHUB_TOKEN/);
});

test("write expands an authoring ref for a secret never seen", () => {
	const { registry } = setup();
	const call = event("write", { path: ".env", content: "GITHUB_TOKEN=<secret:GITHUB_TOKEN>\n" });
	assert.equal(applySecretPolicy(call, registry).block, false);
	assert.equal((call.input as { content: string }).content, `GITHUB_TOKEN=${GH}\n`);
});

test("write is blocked when the payload carries a transcribed mask", () => {
	const { registry } = setup();
	const call = event("write", { path: ".env", content: "GITHUB_TOKEN=ghp_aa****aa\n" });
	const outcome = applySecretPolicy(call, registry);
	assert.equal(outcome.block, true);
	assert.match(outcome.block === true ? outcome.reason : "", /Masked secret value/);
});

test("write is blocked on an unknown ref instead of writing it verbatim", () => {
	const { registry } = setup();
	const content = "GITHUB_TOKEN=<secret:github-token:deadbeef>\n";
	const call = event("write", { path: ".env", content });
	const outcome = applySecretPolicy(call, registry);
	assert.equal(outcome.block, true);
	assert.equal((call.input as { content: string }).content, content);
});

test("write leaves ordinary prose about masking alone", () => {
	const { registry } = setup();
	const content = "Docs: values used to render as prefix****suffix in tool output.\n";
	const call = event("write", { path: "README.md", content });
	assert.equal(applySecretPolicy(call, registry).block, false);
	assert.equal((call.input as { content: string }).content, content);
});

test("edit expands both sides so the match runs against the real file", () => {
	const { registry, named } = setup();
	const call = event("edit", {
		path: ".env",
		edits: [{ oldText: `TOKEN=${named.ref}`, newText: `TOKEN=${named.ref}\nEXTRA=1` }],
	});
	assert.equal(applySecretPolicy(call, registry).block, false);
	const edits = (call.input as { edits: { oldText: string; newText: string }[] }).edits;
	assert.equal(edits[0].oldText, `TOKEN=${GH}`);
	assert.equal(edits[0].newText, `TOKEN=${GH}\nEXTRA=1`);
});

test("applyPatch expands refs in add and update content", () => {
	const { registry, named } = setup();
	const patch = [
		"*** Begin Patch",
		"*** Add File: added.env",
		`+TOKEN=${named.ref}`,
		"*** Update File: existing.env",
		`@@ TOKEN=${named.ref}`,
		`-TOKEN=${named.ref}`,
		`+TOKEN=${named.ref}`,
		"*** End Patch",
	].join("\n");
	const call = event("applyPatch", { patch });
	const outcome = applySecretPolicy(call, registry);
	assert.equal(outcome.block, false);
	assert.equal((call.input as { patch: string }).patch, patch.replaceAll(named.ref, GH));
	assert.match(String(outcome.block === false && outcome.notify), /GITHUB_TOKEN/);
});

test("applyPatch repeats hunk markers for a multiline secret", () => {
	const registry = new SecretRefRegistry(KEY);
	const entry = registry.registerNamed("MULTILINE", "first\nsecond");
	const call = event("applyPatch", {
		patch: `*** Begin Patch\n*** Add File: value.txt\n+${entry.ref}\n*** End Patch`,
	});
	assert.equal(applySecretPolicy(call, registry).block, false);
	assert.match((call.input as { patch: string }).patch, /\+first\n\+second/);
});

test("applyPatch refuses refs in file paths instead of expanding them", () => {
	const { registry, named } = setup();
	const patch = `*** Begin Patch\n*** Add File: ${named.ref}\n+content\n*** End Patch`;
	const call = event("applyPatch", { patch });
	const outcome = applySecretPolicy(call, registry);
	assert.equal(outcome.block, true);
	assert.equal((call.input as { patch: string }).patch, patch);
});

test("applyPatch is blocked on an unknown ref without partially hydrating the patch", () => {
	const { registry, named } = setup();
	const unknown = "<" + "secret:github-token:deadbeef>";
	const patch = [
		"*** Begin Patch",
		"*** Add File: value.txt",
		`+known=${named.ref}`,
		`+unknown=${unknown}`,
		"*** End Patch",
	].join("\n");
	const call = event("applyPatch", { patch });
	const outcome = applySecretPolicy(call, registry);
	assert.equal(outcome.block, true);
	assert.equal((call.input as { patch: string }).patch, patch);
});

test("bash rewrites an env-backed ref to a variable, never a value", () => {
	const { registry, named } = setup();
	const call = event("bash", { command: `curl -H "Authorization: Bearer ${named.ref}"` });
	assert.equal(applySecretPolicy(call, registry).block, false);
	const command = (call.input as { command: string }).command;
	assert.equal(command, 'curl -H "Authorization: Bearer ${GITHUB_TOKEN}"');
	assert.ok(!command.includes(GH));
});

test("bash is blocked for a ref with no environment variable behind it", () => {
	const { registry, detected } = setup();
	const call = event("bash", { command: `echo ${detected.ref}` });
	const outcome = applySecretPolicy(call, registry);
	assert.equal(outcome.block, true);
	assert.ok(!(call.input as { command: string }).command.includes(detected.value));
});

test("bash is blocked when the ref sits inside single quotes", () => {
	const { registry, named } = setup();
	const call = event("bash", { command: `echo '${named.ref}'` });
	assert.equal(applySecretPolicy(call, registry).block, true);
});

test("a ref passed to any other tool is refused, not expanded", () => {
	const { registry, named } = setup();
	for (const tool of ["grep", "fetch_content", "web_search"]) {
		const call = event(tool, { query: `check ${named.ref}` });
		const outcome = applySecretPolicy(call, registry);
		assert.equal(outcome.block, true, `${tool} must refuse refs`);
		assert.match(outcome.block === true ? outcome.reason : "", /only expand in write, edit, and applyPatch/);
	}
});

test("a tool call with no refs is untouched", () => {
	const { registry } = setup();
	const call = event("grep", { pattern: "TODO" });
	assert.equal(applySecretPolicy(call, registry).block, false);
});

test("a code-passthrough tool is allowed, since its nested write is hydrated", () => {
	const { registry, named } = setup();
	const code = `await pi.write({ path: ".env", content: "T=${named.ref}" })`;
	const call = event("code_mode", { code });
	assert.equal(applySecretPolicy(call, registry).block, false);
	assert.equal((call.input as { code: string }).code, code);
});

test("an uninspectable payload fails closed", () => {
	const { registry } = setup();
	const circular: Record<string, unknown> = {};
	circular.self = circular;
	const outcome = applySecretPolicy(event("weird_tool", circular), registry);
	assert.equal(outcome.block, true);
});
