import assert from "node:assert/strict";
import { test } from "node:test";
import { buildChromeArgs, mainDocumentStatus } from "./browser.ts";

test("buildChromeArgs wires the debugging port and profile", () => {
	const args = buildChromeArgs(9333, "/tmp/prof");
	assert.ok(args.includes("--remote-debugging-port=9333"));
	assert.ok(args.includes("--user-data-dir=/tmp/prof"));
	assert.ok(args.includes("--remote-allow-origins=*"));
	// Ends on about:blank so nothing is navigated until we drive it via CDP.
	assert.equal(args.at(-1), "about:blank");
});

test("mainDocumentStatus prefers the navigated frame over iframes", () => {
	const docs = [
		{ frameId: "iframe-1", status: 200 },
		{ frameId: "main", status: 404 },
	];
	assert.equal(mainDocumentStatus(docs, "main"), 404);
});

test("mainDocumentStatus falls back to the first document seen", () => {
	assert.equal(mainDocumentStatus([{ frameId: "a", status: 503 }], "unknown-frame"), 503);
	assert.equal(mainDocumentStatus([], "main"), undefined);
	assert.equal(mainDocumentStatus([{ status: 200 }]), 200);
});
