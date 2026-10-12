import assert from "node:assert/strict";
import { test } from "node:test";
import { hiddenTargetParams, mainDocumentStatus } from "./browser.ts";

test("hiddenTargetParams omits newWindow, which Chromium rejects for hidden targets", () => {
	const params = hiddenTargetParams();
	assert.equal(params.hidden, true);
	assert.equal(params.background, true);
	assert.ok(!("newWindow" in params));
});

test("mainDocumentStatus prefers the navigated frame over iframes", () => {
	const docs = [
		{ frameId: "iframe-1", status: 200 },
		{ frameId: "main", status: 404 },
	];
	assert.equal(mainDocumentStatus(docs, "main"), 404);
});

test("mainDocumentStatus reports the page that replaced a passed challenge", () => {
	const docs = [
		{ frameId: "main", status: 403 },
		{ frameId: "iframe-1", status: 200 },
		{ frameId: "main", status: 200 },
	];
	assert.equal(mainDocumentStatus(docs, "main"), 200);
});

test("mainDocumentStatus falls back to the first document seen", () => {
	assert.equal(mainDocumentStatus([{ frameId: "a", status: 503 }], "unknown-frame"), 503);
	assert.equal(mainDocumentStatus([], "main"), undefined);
	assert.equal(mainDocumentStatus([{ status: 200 }]), 200);
});
