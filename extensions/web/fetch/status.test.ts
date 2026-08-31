import assert from "node:assert/strict";
import { test } from "node:test";
import { isSoftNotFound, shouldEscalateToBrowser } from "./status.ts";

test("shouldEscalateToBrowser retries blocking and transient failures", () => {
	for (const status of [undefined, 403, 406, 408, 425, 429, 451, 500, 502, 503, 521]) {
		assert.equal(shouldEscalateToBrowser(status), true, `expected retry for ${status}`);
	}
});

test("shouldEscalateToBrowser does not retry conclusive client errors", () => {
	for (const status of [400, 401, 404, 410, 418, 422]) {
		assert.equal(shouldEscalateToBrowser(status), false, `expected no retry for ${status}`);
	}
});

test("isSoftNotFound flags short not-found placeholders", () => {
	assert.equal(isSoftNotFound({ title: "404 | Example Docs", markdown: "This page could not be found." }), true);
	assert.equal(isSoftNotFound({ title: "Page Not Found", markdown: "Try the search instead." }), true);
	assert.equal(isSoftNotFound({ markdown: "# Not Found\n\nSorry." }), true);
	assert.equal(isSoftNotFound({ title: "Oops", markdown: "# This page no longer exists\n\nSorry." }), true);
});

test("isSoftNotFound ignores real articles about 404s", () => {
	const body = `${"How we cut our 404 rate in half. ".repeat(40)}`;
	assert.equal(isSoftNotFound({ title: "Debugging 404s at scale", markdown: body }), false);
	assert.equal(isSoftNotFound({ title: "Fixture Article", markdown: "# Hello There\n\nA short post." }), false);
	assert.equal(isSoftNotFound({ markdown: "" }), false);
});
