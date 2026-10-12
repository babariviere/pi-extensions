import assert from "node:assert/strict";
import { test } from "node:test";
import { formatElement, formatSnapshot, snapshotExpression } from "./snapshot.ts";

test("formatElement renders role, name, state, and link targets", () => {
	assert.equal(
		formatElement({ ref: 1, role: "link", name: "Docs", href: "https://x.dev/docs" }),
		'[1] link "Docs" -> https://x.dev/docs',
	);
	assert.equal(
		formatElement({ ref: 2, role: "textbox", name: "Search", value: "pi", offscreen: true }),
		'[2] textbox "Search" value="pi" offscreen',
	);
	assert.equal(
		formatElement({ ref: 3, role: "checkbox", name: "Agree", checked: false, disabled: true }),
		'[3] checkbox "Agree" unchecked disabled',
	);
});

test("formatSnapshot notes truncated text and element caps", () => {
	const out = formatSnapshot({
		url: "https://x.dev",
		title: "X",
		text: "hello",
		textTruncated: true,
		totalTextChars: 900,
		elements: [{ ref: 1, role: "button", name: "Go" }],
		totalElements: 4,
	});
	assert.match(out, /^Title: X\nURL: https:\/\/x\.dev/);
	assert.match(out, /Text \(first 5 of 900 chars\):\nhello/);
	assert.match(out, /Elements \(1 of 4\):\n\[1\] button "Go"/);
});

test("snapshotExpression is a self-contained call", () => {
	const expr = snapshotExpression(100, 5);
	assert.match(expr, /^\(\(maxChars, maxElements, refAttribute\) => \{/);
	assert.ok(expr.endsWith('(100, 5, "data-pi-ref")'));
	// Parses as plain JavaScript (no TypeScript syntax leaks into the page).
	assert.doesNotThrow(() => new Function(`return ${expr.slice(0, expr.lastIndexOf("("))}`));
});
