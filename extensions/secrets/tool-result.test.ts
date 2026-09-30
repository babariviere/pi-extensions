import assert from "node:assert/strict";
import { test } from "node:test";
import { scrubToolResult } from "./secret-mask.ts";
import { SecretRefRegistry } from "./secret-ref.ts";

const secret = { name: "TOKEN", value: "supersecretvalue123" };

test("structured-only secrets are scrubbed without a content patch or mutation", () => {
	const registry = new SecretRefRegistry();
	const safe = { count: 2 };
	const result = {
		content: [{ type: "text", text: "Safe display output" }],
		details: undefined,
		structuredContent: { nested: [{ token: secret.value }], safe },
	};
	const patch = scrubToolResult(result, [secret], registry);
	assert.ok(patch?.structuredContent);
	assert.equal(Object.hasOwn(patch, "content"), false);
	assert.equal(Object.hasOwn(patch, "details"), false);
	assert.match(patch.structuredContent.nested[0].token, /^<secret:token:[0-9a-f]+>$/);
	assert.equal(patch.structuredContent.safe, safe);
	assert.equal(result.structuredContent.nested[0].token, secret.value);
	assert.equal(scrubToolResult({ ...result, ...patch }, [secret], registry), undefined);
});

test("structured-only pattern secrets are detected without fnox", () => {
	const token = `ghp_${"a".repeat(36)}`;
	const result = { content: [], details: undefined, structuredContent: { data: [token] } };
	const patch = scrubToolResult(result, [], new SecretRefRegistry());
	assert.ok(patch?.structuredContent);
	assert.ok(!JSON.stringify(patch).includes(token));
});

test("top-level structured strings and arrays are scrubbed", () => {
	for (const structuredContent of [secret.value, [secret.value, { token: secret.value }]]) {
		const patch = scrubToolResult(
			{ content: [], details: undefined, structuredContent },
			[secret],
			new SecretRefRegistry(),
		);
		assert.ok(patch?.structuredContent);
		assert.ok(!JSON.stringify(patch).includes(secret.value));
		assert.equal(Object.hasOwn(patch, "content"), false);
	}
});

test("content patches preserve clean structured results by reference", () => {
	const structuredContent = { results: [{ title: "Safe" }] };
	const result = { content: [{ type: "text", text: secret.value }], details: undefined, structuredContent };
	const patch = scrubToolResult(result, [secret]);
	assert.ok(patch?.content);
	assert.ok(!patch.content[0].text.includes(secret.value));
	assert.equal(patch.structuredContent, structuredContent);
});

test("details-only patches do not replace content or discard structured results", () => {
	const result = {
		content: [{ type: "text", text: "Safe" }],
		details: { token: secret.value },
		structuredContent: { count: 1 },
		isError: true,
	};
	const patch = scrubToolResult(result, [secret]);
	assert.ok(patch?.details);
	assert.ok(!patch.details.token.includes(secret.value));
	assert.equal(Object.hasOwn(patch, "content"), false);
	assert.equal(Object.hasOwn(patch, "structuredContent"), false);
	assert.equal({ ...result, ...patch }.isError, true);
});

test("all three result channels are scrubbed together", () => {
	const result = {
		content: [{ type: "text", text: secret.value }],
		details: { token: secret.value },
		structuredContent: { token: secret.value },
	};
	const patch = scrubToolResult(result, [secret], new SecretRefRegistry());
	assert.ok(patch?.content && patch.details && patch.structuredContent);
	assert.equal(patch.content[0].text, patch.details.token);
	assert.equal(patch.content[0].text, patch.structuredContent.token);
	assert.ok(!JSON.stringify(patch).includes(secret.value));
});

test("untouched results, including structured null, need no patch", () => {
	for (const structuredContent of [undefined, null, { items: ["safe", 1, false] }]) {
		assert.equal(scrubToolResult({ content: [], details: { safe: true }, structuredContent }, [secret]), undefined);
	}
});
