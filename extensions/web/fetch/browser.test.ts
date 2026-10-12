import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildChromeArgs,
	buildMacOpenArgs,
	findBrowser,
	hiddenTargetParams,
	isChallengeTitle,
	mainDocumentStatus,
} from "./browser.ts";

test("buildChromeArgs wires the debugging port and profile", () => {
	const args = buildChromeArgs(9333, "/tmp/prof");
	assert.ok(args.includes("--remote-debugging-port=9333"));
	assert.ok(args.includes("--user-data-dir=/tmp/prof"));
	assert.ok(args.includes("--remote-allow-origins=*"));
	// No startup window: pages are hidden targets driven over CDP.
	assert.ok(args.includes("--no-startup-window"));
	assert.ok(!args.includes("about:blank"));
});

test("findBrowser prefers Helium, then Chrome, then Chromium", () => {
	const installed = (paths: string[]) => (p: string) => paths.includes(p);
	const all = ["/Applications/Helium.app", "/Applications/Google Chrome.app", "/Applications/Chromium.app"];
	assert.equal(findBrowser("darwin", installed(all))?.id, "helium");
	assert.equal(findBrowser("darwin", installed(all.slice(1)))?.id, "chrome");
	assert.equal(findBrowser("darwin", installed(all.slice(2)))?.id, "chromium");
	assert.equal(findBrowser("darwin", installed([])), null);
	assert.deepEqual(findBrowser("linux", installed(["/usr/bin/chromium"])), {
		id: "chromium",
		path: "/usr/bin/chromium",
	});
});

test("buildMacOpenArgs launches a new hidden instance in the background", () => {
	const args = buildMacOpenArgs("/Applications/Helium.app", ["--x"]);
	assert.deepEqual(args, ["-g", "-j", "-n", "-a", "/Applications/Helium.app", "--args", "--x"]);
});

test("hiddenTargetParams omits newWindow, which Chromium rejects for hidden targets", () => {
	const params = hiddenTargetParams();
	assert.equal(params.hidden, true);
	assert.equal(params.background, true);
	assert.ok(!("newWindow" in params));
});

test("isChallengeTitle recognises bot-protection interstitials only", () => {
	assert.ok(isChallengeTitle("Just a moment..."));
	assert.ok(isChallengeTitle("Attention Required! | Cloudflare"));
	assert.ok(!isChallengeTitle("Cloudflare Challenge - ScrapingCourse.com"));
	assert.ok(!isChallengeTitle("Example Domain"));
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
