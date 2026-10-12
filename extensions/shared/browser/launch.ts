/**
 * Launch (or reuse) the background Chromium browser shared by the web fetch
 * fallback and the browser tool.
 *
 * The first installed browser wins, in order: Helium, Chrome, Chromium. It runs
 * as a separate instance with a dedicated profile and a remote debugging port,
 * starts hidden with no window (`open -g -j -n` on macOS, `--no-startup-window`),
 * and stays warm across calls.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CdpError, type CdpSession } from "./cdp.ts";

/** A browser install that can be driven. `id` keys its dedicated profile. */
export interface BrowserInstall {
	id: string;
	/** macOS: app bundle path, opened with `open`. Linux: executable path. */
	path: string;
}

const MAC_BROWSERS: BrowserInstall[] = [
	{ id: "helium", path: "/Applications/Helium.app" },
	{ id: "chrome", path: "/Applications/Google Chrome.app" },
	{ id: "chromium", path: "/Applications/Chromium.app" },
];

const LINUX_BROWSERS: BrowserInstall[] = [
	{ id: "helium", path: "/usr/bin/helium" },
	{ id: "helium", path: "/opt/helium/helium" },
	{ id: "chrome", path: "/usr/bin/google-chrome" },
	{ id: "chrome", path: "/usr/bin/google-chrome-stable" },
	{ id: "chrome", path: "/opt/google/chrome/chrome" },
	{ id: "chromium", path: "/usr/bin/chromium" },
	{ id: "chromium", path: "/usr/bin/chromium-browser" },
	{ id: "chromium", path: "/snap/bin/chromium" },
];

/** First installed browser in preference order (Helium first). */
export function findBrowser(
	platform: NodeJS.Platform = process.platform,
	exists: (path: string) => boolean = existsSync,
): BrowserInstall | null {
	const candidates = platform === "darwin" ? MAC_BROWSERS : LINUX_BROWSERS;
	return candidates.find((b) => exists(b.path)) ?? null;
}

/**
 * Persistent profile directory for the background browser, one per browser
 * kind (`helium`, `chrome`, `chromium`) so profiles are never shared across
 * incompatible versions. Uses XDG_CACHE_HOME when set, otherwise ~/.cache, so
 * the profile (and its warm Cloudflare clearance cookies) survives across runs.
 */
export function browserProfileDir(browser = "chrome"): string {
	const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
	return join(base, "pi-web-extension", `${browser}-profile`);
}

/** Chromium flags shared across platforms. */
export function buildChromeArgs(port: number, profileDir: string): string[] {
	return [
		`--remote-debugging-port=${port}`,
		"--remote-allow-origins=*",
		`--user-data-dir=${profileDir}`,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-sync",
		"--use-mock-keychain",
		"--password-store=basic",
		"--mute-audio",
		// Start with no window at all; pages are opened later over CDP.
		"--no-startup-window",
	];
}

/** macOS `open` arguments: background (-g), hidden (-j), new instance (-n). */
export function buildMacOpenArgs(appPath: string, browserArgs: string[]): string[] {
	return ["-g", "-j", "-n", "-a", appPath, "--args", ...browserArgs];
}

export async function cdpWebSocketUrl(port: number): Promise<string | null> {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/json/version`);
		if (!res.ok) return null;
		const data = (await res.json()) as { webSocketDebuggerUrl?: string };
		return data.webSocketDebuggerUrl ?? null;
	} catch {
		return null;
	}
}

/** Reuse a live browser on the port, else launch one in the background and wait for it. */
export async function ensureBrowser(port: number, signal?: AbortSignal): Promise<string> {
	const existing = await cdpWebSocketUrl(port);
	if (existing) return existing;

	const browser = findBrowser();
	if (!browser) throw new CdpError("No Helium, Chrome, or Chromium installation found");
	const profileDir = browserProfileDir(browser.id);
	mkdirSync(profileDir, { recursive: true });
	launchBrowser(browser, port, profileDir);

	for (let i = 0; i < 80; i++) {
		if (signal?.aborted) throw new CdpError("Browser launch aborted");
		await sleep(250);
		const ws = await cdpWebSocketUrl(port);
		if (ws) return ws;
	}
	throw new CdpError(`Browser did not expose a debugging port on ${port}`);
}

function launchBrowser(browser: BrowserInstall, port: number, profileDir: string): void {
	const args = buildChromeArgs(port, profileDir);

	if (process.platform === "darwin") {
		// A dedicated profile lets this instance run alongside the user's own
		// browser of the same kind without touching their session.
		spawn("/usr/bin/open", buildMacOpenArgs(browser.path, args), {
			stdio: "ignore",
			detached: true,
		}).unref();
		return;
	}

	const extra = process.getuid?.() === 0 ? ["--no-sandbox"] : [];
	spawn(browser.path, [...args, ...extra], { stdio: "ignore", detached: true }).unref();
}

/** Titles of bot-protection interstitials that resolve on their own. */
export function isChallengeTitle(title: string): boolean {
	return /^(just a moment|attention required|checking your browser|please wait|ddos-guard)\b/i.test(title.trim());
}

export interface NavigateResult {
	frameId?: string;
	errorText?: string;
	isDownload?: boolean;
}

/**
 * Page.navigate, retrying spurious aborts. A freshly launched browser cancels
 * its first navigations (net::ERR_ABORTED) while it finishes starting up,
 * leaving the page on about:blank. A real hand-off such as a download is not
 * retried.
 */
export async function navigate(
	page: CdpSession,
	url: string,
	options: { timeoutMs?: number; retries?: number; retryDelayMs?: number } = {},
): Promise<NavigateResult> {
	const retries = options.retries ?? 4;
	for (let attempt = 0; ; attempt++) {
		const nav: NavigateResult = await page.call("Page.navigate", { url }, { timeoutMs: options.timeoutMs });
		if (nav?.errorText !== "net::ERR_ABORTED" || nav.isDownload || attempt >= retries) return nav;
		await sleep(options.retryDelayMs ?? 500);
		const href = await page
			.call("Runtime.evaluate", { expression: "location.href", returnByValue: true }, { timeoutMs: 2_000 })
			.then((r) => r?.result?.value as string | undefined)
			.catch(() => undefined);
		if (href && href !== "about:blank") return nav;
	}
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
