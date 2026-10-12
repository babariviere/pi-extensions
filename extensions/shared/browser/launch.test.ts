import assert from "node:assert/strict";
import { test } from "node:test";
import type { CdpSession } from "./cdp.ts";
import {
	browserProfileDir,
	buildChromeArgs,
	buildMacOpenArgs,
	findBrowser,
	isChallengeTitle,
	navigate,
} from "./launch.ts";

/** Fake page whose first `aborts` navigations are cancelled and leave it on about:blank. */
function fakePage(aborts: number, download = false) {
	let href = "about:blank";
	let navigations = 0;
	const page: CdpSession = {
		async call(method, params) {
			if (method === "Page.navigate") {
				navigations++;
				if (navigations <= aborts) return { errorText: "net::ERR_ABORTED", isDownload: download };
				href = String(params?.url);
				return { frameId: "main" };
			}
			return { result: { value: href } };
		},
		on: () => () => {},
	};
	return { page, navigations: () => navigations };
}

test("navigate retries aborts that leave the page blank", async () => {
	const fake = fakePage(2);
	const nav = await navigate(fake.page, "https://x.dev", { retryDelayMs: 0 });
	assert.equal(nav.errorText, undefined);
	assert.equal(fake.navigations(), 3);
});

test("navigate does not retry downloads and gives up after its retries", async () => {
	const download = fakePage(5, true);
	assert.equal((await navigate(download.page, "https://x.dev/f.zip", { retryDelayMs: 0 })).isDownload, true);
	assert.equal(download.navigations(), 1);
	const stuck = fakePage(10);
	assert.equal(
		(await navigate(stuck.page, "https://x.dev", { retryDelayMs: 0, retries: 2 })).errorText,
		"net::ERR_ABORTED",
	);
	assert.equal(stuck.navigations(), 3);
});

test("buildChromeArgs wires the debugging port and profile", () => {
	const args = buildChromeArgs(9333, "/tmp/prof");
	assert.ok(args.includes("--remote-debugging-port=9333"));
	assert.ok(args.includes("--user-data-dir=/tmp/prof"));
	assert.ok(args.includes("--remote-allow-origins=*"));
	// No startup window: pages are created over CDP.
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

test("browserProfileDir honors XDG_CACHE_HOME then falls back to ~/.cache", () => {
	const prev = process.env.XDG_CACHE_HOME;
	try {
		process.env.XDG_CACHE_HOME = "/tmp/xdg";
		assert.equal(browserProfileDir(), "/tmp/xdg/pi-web-extension/chrome-profile");
		assert.equal(browserProfileDir("helium"), "/tmp/xdg/pi-web-extension/helium-profile");
		delete process.env.XDG_CACHE_HOME;
		assert.match(browserProfileDir(), /\/\.cache\/pi-web-extension\/chrome-profile$/);
	} finally {
		if (prev === undefined) delete process.env.XDG_CACHE_HOME;
		else process.env.XDG_CACHE_HOME = prev;
	}
});

test("isChallengeTitle recognises bot-protection interstitials only", () => {
	assert.ok(isChallengeTitle("Just a moment..."));
	assert.ok(isChallengeTitle("Attention Required! | Cloudflare"));
	assert.ok(!isChallengeTitle("Cloudflare Challenge - ScrapingCourse.com"));
	assert.ok(!isChallengeTitle("Example Domain"));
});
