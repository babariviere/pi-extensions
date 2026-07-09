/**
 * Tier 2 fallback: fetch a page through a real, headed Chrome driven over the
 * DevTools Protocol, for sites that block a plain fetch (e.g. Cloudflare's
 * "Just a moment..." managed challenge, which detects headless browsers).
 *
 * Approach (after antirez's ds4_web.c): launch the user's real Chrome in the
 * background (`open -g` on macOS) with a dedicated profile and remote debugging
 * port, keep it warm across calls, open pages as background tabs, and enable
 * focus emulation so the backgrounded page still runs the challenge JS. The
 * rendered outerHTML is then handed to the same defuddle extractor as Tier 1.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import WebSocket from "ws";
import { browserProfileDir } from "../utils.ts";
import { assertSafeUrl, DefuddleError, type DefuddleResult, extractMarkdown } from "./defuddle.ts";

interface BrowserFetchOptions {
	timeout: number;
	port: number;
	signal?: AbortSignal;
}

export async function browserFetch(url: string, options: BrowserFetchOptions): Promise<DefuddleResult> {
	assertSafeUrl(url);

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeout);
	const onAbort = () => controller.abort();
	options.signal?.addEventListener("abort", onAbort, { once: true });

	try {
		const browserWs = await ensureBrowser(options.port, controller.signal);
		const { html, title } = await renderPage(browserWs, options.port, url, controller.signal);
		const extracted = await extractMarkdown(html, url);
		return {
			title: extracted.title || title || undefined,
			date: extracted.date,
			markdown: extracted.markdown,
			contentType: "text/html (browser)",
		};
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
	}
}

// --- browser lifecycle ------------------------------------------------------

async function cdpWebSocketUrl(port: number): Promise<string | null> {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/json/version`);
		if (!res.ok) return null;
		const data = (await res.json()) as { webSocketDebuggerUrl?: string };
		return data.webSocketDebuggerUrl ?? null;
	} catch {
		return null;
	}
}

/** Reuse a live Chrome on the port, else launch one in the background and wait. */
async function ensureBrowser(port: number, signal: AbortSignal): Promise<string> {
	const existing = await cdpWebSocketUrl(port);
	if (existing) return existing;

	const profileDir = browserProfileDir();
	mkdirSync(profileDir, { recursive: true });
	launchChrome(port, profileDir);

	for (let i = 0; i < 80; i++) {
		if (signal.aborted) throw new DefuddleError("Browser launch aborted");
		await sleep(250);
		const ws = await cdpWebSocketUrl(port);
		if (ws) return ws;
	}
	throw new DefuddleError(`Chrome did not expose a debugging port on ${port}`);
}

/** Chrome flags shared across platforms. Exported for testing. */
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
		"about:blank",
	];
}

function launchChrome(port: number, profileDir: string): void {
	const args = buildChromeArgs(port, profileDir);

	if (process.platform === "darwin") {
		const app = macChromeApp();
		if (!app) throw new DefuddleError("No Chrome or Chromium found in /Applications");
		// `open -g` launches without stealing focus; a dedicated profile lets it
		// run alongside the user's own Chrome.
		spawn("/usr/bin/open", ["-g", "-na", app, "--args", ...args], {
			stdio: "ignore",
			detached: true,
		}).unref();
		return;
	}

	const exe = linuxChromeExecutable();
	if (!exe) throw new DefuddleError("No Chrome or Chromium executable found");
	const extra = process.getuid?.() === 0 ? ["--no-sandbox"] : [];
	spawn(exe, [...args, ...extra], { stdio: "ignore", detached: true }).unref();
}

function macChromeApp(): string | null {
	if (existsSync("/Applications/Google Chrome.app")) return "Google Chrome";
	if (existsSync("/Applications/Chromium.app")) return "Chromium";
	return null;
}

function linuxChromeExecutable(): string | null {
	const candidates = [
		"/usr/bin/google-chrome",
		"/usr/bin/google-chrome-stable",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
		"/snap/bin/chromium",
		"/opt/google/chrome/chrome",
	];
	return candidates.find((p) => existsSync(p)) ?? null;
}

// --- page rendering ---------------------------------------------------------

async function renderPage(
	browserWsUrl: string,
	port: number,
	url: string,
	signal: AbortSignal,
): Promise<{ html: string; title: string }> {
	const browser = new Cdp(browserWsUrl, signal);
	await browser.connect();
	let targetId: string;
	try {
		const created = await browser.call("Target.createTarget", {
			url: "about:blank",
			background: true,
			newWindow: false,
		});
		targetId = created.targetId;
	} finally {
		browser.close();
	}

	const page = new Cdp(`ws://127.0.0.1:${port}/devtools/page/${targetId}`, signal);
	await page.connect();
	try {
		await page.call("Page.enable");
		await page.call("Runtime.enable");
		// Keep the backgrounded page from throttling its JS so the challenge runs.
		await page.call("Emulation.setFocusEmulationEnabled", { enabled: true });
		await page.call("Emulation.setDeviceMetricsOverride", {
			width: 1365,
			height: 900,
			deviceScaleFactor: 1,
			mobile: false,
		});
		await page.call("Page.navigate", { url });
		await waitReady(page, signal);
		const html = await evalString(page, "document.documentElement.outerHTML");
		const title = await evalString(page, "document.title");
		return { html, title };
	} finally {
		page.close();
		await fetch(`http://127.0.0.1:${port}/json/close/${encodeURIComponent(targetId)}`).catch(() => {});
	}
}

async function evalString(page: Cdp, expr: string): Promise<string> {
	const r = await page.call("Runtime.evaluate", {
		expression: expr,
		returnByValue: true,
		awaitPromise: true,
	});
	if (r.exceptionDetails) throw new DefuddleError("JavaScript evaluation failed in browser");
	return (r.result?.value ?? "") as string;
}

/**
 * Poll until the page is a real URL, is ready, and its text length has settled,
 * which naturally waits out interstitial challenge pages.
 */
async function waitReady(page: Cdp, signal: AbortSignal): Promise<void> {
	let lastLen = -1;
	let stable = 0;
	let sawRealUrl = false;

	for (let i = 0; i < 100; i++) {
		if (signal.aborted) throw new DefuddleError("Browser navigation aborted");
		await sleep(400);
		const probe = await evalString(
			page,
			"location.href+'\\n'+document.readyState+'\\n'+((document.body&&document.body.innerText)||'').length",
		);
		const [href, ready, lenStr] = probe.split("\n");
		const len = Number.parseInt(lenStr || "0", 10);
		const realUrl = !!href && href !== "about:blank" && !href.startsWith("chrome://");
		const readyOk = ready === "complete" || ready === "interactive";
		if (realUrl) sawRealUrl = true;
		if (len > 0 && len === lastLen) stable++;
		else stable = 0;
		lastLen = len;

		if (sawRealUrl && readyOk && len > 0 && stable >= 2) return;
		if (sawRealUrl && readyOk && i >= 24) return; // give up waiting for stability
	}
}

// --- minimal CDP client -----------------------------------------------------

interface Pending {
	resolve: (value: any) => void;
	reject: (err: Error) => void;
}

class Cdp {
	private ws!: WebSocket;
	private id = 1;
	private pending = new Map<number, Pending>();
	private readonly onAbort = () => this.fail(new DefuddleError("Browser operation aborted"));

	constructor(
		private readonly url: string,
		private readonly signal: AbortSignal,
	) {}

	connect(): Promise<void> {
		return new Promise((resolve, reject) => {
			if (this.signal.aborted) return reject(new DefuddleError("Browser operation aborted"));
			this.ws = new WebSocket(this.url);
			this.ws.on("open", () => {
				this.signal.addEventListener("abort", this.onAbort, { once: true });
				resolve();
			});
			this.ws.on("error", (err) => {
				this.close();
				reject(new DefuddleError(`CDP socket error: ${err.message}`));
			});
			this.ws.on("message", (data) => {
				let msg: any;
				try {
					msg = JSON.parse(data.toString());
				} catch {
					return;
				}
				if (typeof msg.id === "number" && this.pending.has(msg.id)) {
					const p = this.pending.get(msg.id)!;
					this.pending.delete(msg.id);
					if (msg.error) p.reject(new DefuddleError(msg.error.message ?? "CDP error"));
					else p.resolve(msg.result);
				}
			});
		});
	}

	call(method: string, params: Record<string, unknown> = {}): Promise<any> {
		if (this.signal.aborted) return Promise.reject(new DefuddleError("Browser operation aborted"));
		const id = this.id++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.ws.send(JSON.stringify({ id, method, params }));
		});
	}

	private fail(err: Error): void {
		for (const { reject } of this.pending.values()) reject(err);
		this.pending.clear();
		this.close();
	}

	close(): void {
		this.signal.removeEventListener("abort", this.onAbort);
		try {
			this.ws?.close();
		} catch {
			// already closed
		}
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
