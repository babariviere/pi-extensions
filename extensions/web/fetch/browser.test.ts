import assert from "node:assert/strict";
import { test } from "node:test";
import { buildChromeArgs } from "./browser.ts";

test("buildChromeArgs wires the debugging port and profile", () => {
	const args = buildChromeArgs(9333, "/tmp/prof");
	assert.ok(args.includes("--remote-debugging-port=9333"));
	assert.ok(args.includes("--user-data-dir=/tmp/prof"));
	assert.ok(args.includes("--remote-allow-origins=*"));
	// Ends on about:blank so nothing is navigated until we drive it via CDP.
	assert.equal(args.at(-1), "about:blank");
});
