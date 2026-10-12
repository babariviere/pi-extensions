/**
 * Tier 2 fallback: fetch a page through a real, headed Chromium browser driven
 * over the DevTools Protocol, for sites that block a plain fetch (e.g.
 * Cloudflare's "Just a moment..." managed challenge, which detects headless
 * browsers).
 *
 * Approach (after antirez's ds4_web.c): launch the user's real browser (Helium,
 * then Chrome, then Chromium) in the background with a dedicated profile and
 * remote debugging port, and keep it warm across calls. To stay out of the way
 * it starts without a window (and hidden on macOS), and pages are opened as
 * hidden targets that never appear in a tab strip. Focus emulation keeps the
 * backgrounded page running the challenge JS. The rendered outerHTML is then
 * handed to the same defuddle extractor as Tier 1.
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
		const { html, title, status } = await renderPage(browserWs, options.port, url, controller.signal);
		const extracted = await extractMarkdown(html, url);
		return {
			title: extracted.title || title || undefined,
			date: extracted.date,
			markdown: extracted.markdown,
			contentType: "text/html (browser)",
			status,
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

	const browser = findBrowser();
	if (!browser) throw new DefuddleError("No Helium, Chrome, or Chromium installation found");
	const profileDir = browserProfileDir(browser.id);
	mkdirSync(profileDir, { recursive: true });
	launchBrowser(browser, port, profileDir);

	for (let i = 0; i < 80; i++) {
		if (signal.aborted) throw new DefuddleError("Browser launch aborted");
		await sleep(250);
		const ws = await cdpWebSocketUrl(port);
		if (ws) return ws;
	}
	throw new DefuddleError(`Browser did not expose a debugging port on ${port}`);
}

/** Chromium flags shared across platforms. Exported for testing. */
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
		// Start with no window at all; pages are opened later as hidden targets.
		"--no-startup-window",
	];
}

/** A browser install the fallback can drive. `id` keys its dedicated profile. */
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

/** First installed browser in preference order (Helium first). Exported for testing. */
export function findBrowser(
	platform: NodeJS.Platform = process.platform,
	exists: (path: string) => boolean = existsSync,
): BrowserInstall | null {
	const candidates = platform === "darwin" ? MAC_BROWSERS : LINUX_BROWSERS;
	return candidates.find((b) => exists(b.path)) ?? null;
}

/** macOS `open` arguments: background (-g), hidden (-j), new instance (-n). Exported for testing. */
export function buildMacOpenArgs(appPath: string, browserArgs: string[]): string[] {
	return ["-g", "-j", "-n", "-a", appPath, "--args", ...browserArgs];
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

// --- page rendering ---------------------------------------------------------

/** A `Network.responseReceived` event for a document (main frame or iframe). */
export interface DocumentResponse {
	frameId?: string;
	status?: number;
}

/**
 * Pick the status of the top-level document. Chrome reports document responses
 * for iframes too, so prefer the frame the navigation was issued on and fall
 * back to the first document seen. Within the main frame take the latest one:
 * a bot challenge (e.g. Cloudflare's 403 "Just a moment...") reloads the frame
 * with the real page once it passes.
 */
export function mainDocumentStatus(documents: DocumentResponse[], mainFrameId?: string): number | undefined {
	const forMainFrame = mainFrameId ? documents.filter((d) => d.frameId === mainFrameId) : [];
	if (forMainFrame.length > 0) return forMainFrame.at(-1)?.status;
	return documents[0]?.status;
}

/**
 * Target.createTarget parameters for a page the user never sees. `hidden`
 * keeps it out of every tab strip and window (no browser window is needed), and
 * lives only as long as the creating session. It requires `background: true`,
 * and `newWindow` must be omitted entirely: Chromium rejects hidden targets
 * whenever that field is present, even when it is false. Exported for testing.
 */
export function hiddenTargetParams(): Record<string, unknown> {
	return { url: "about:blank", background: true, hidden: true };
}

async function renderPage(
	browserWsUrl: string,
	port: number,
	url: string,
	signal: AbortSignal,
): Promise<{ html: string; title: string; status?: number }> {
	// One browser-level socket for the whole render: a hidden target is tied to
	// the session that created it, so the page is driven through a flattened
	// session on this same connection rather than a separate page socket.
	const cdp = new Cdp(browserWsUrl, signal);
	await cdp.connect();
	let targetId: string | undefined;
	try {
		targetId = (await cdp.call("Target.createTarget", hiddenTargetParams())).targetId as string;
		const { sessionId } = await cdp.call("Target.attachToTarget", { targetId, flatten: true });
		const page = cdp.session(sessionId);

		await page.call("Page.enable");
		await page.call("Runtime.enable");
		// Needed to observe the HTTP status: CDP navigation itself reports none, so
		// without this a 404 page renders and passes for real content.
		await page.call("Network.enable");

		const documents: DocumentResponse[] = [];
		page.on("Network.responseReceived", (params) => {
			if (params?.type !== "Document") return;
			documents.push({ frameId: params.frameId, status: params.response?.status });
		});

		// Keep the backgrounded page from throttling its JS so the challenge runs.
		await page.call("Emulation.setFocusEmulationEnabled", { enabled: true });
		await page.call("Emulation.setDeviceMetricsOverride", {
			width: 1365,
			height: 900,
			deviceScaleFactor: 1,
			mobile: false,
		});
		const nav = await page.call("Page.navigate", { url });
		// ERR_ABORTED is expected for navigations Chrome hands off (downloads, etc.).
		if (nav?.errorText && nav.errorText !== "net::ERR_ABORTED") {
			throw new DefuddleError(`Browser navigation failed: ${nav.errorText}`);
		}
		await waitReady(page, signal);
		const html = await evalString(page, "document.documentElement.outerHTML");
		const title = await evalString(page, "document.title");
		return { html, title, status: mainDocumentStatus(documents, nav?.frameId) };
	} finally {
		if (targetId) {
			const id = targetId;
			await cdp.call("Target.closeTarget", { targetId: id }).catch(() =>
				// The socket may already be gone (abort); close over HTTP as a fallback.
				fetch(`http://127.0.0.1:${port}/json/close/${encodeURIComponent(id)}`).catch(() => {}),
			);
		}
		cdp.close();
	}
}

async function evalString(page: CdpSession, expr: string): Promise<string> {
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
async function waitReady(page: CdpSession, signal: AbortSignal): Promise<void> {
	let lastLen = -1;
	let stable = 0;
	let sawRealUrl = false;

	for (let i = 0; i < 100; i++) {
		if (signal.aborted) throw new DefuddleError("Browser navigation aborted");
		await sleep(400);
		const probe = await evalString(
			page,
			"location.href+'\\n'+document.readyState+'\\n'+((document.body&&document.body.innerText)||'').length+'\\n'+document.title",
		);
		const [href, ready, lenStr, ...titleParts] = probe.split("\n");
		const len = Number.parseInt(lenStr || "0", 10);
		const realUrl = !!href && href !== "about:blank" && !href.startsWith("chrome://");
		const readyOk = ready === "complete" || ready === "interactive";
		if (realUrl) sawRealUrl = true;
		if (len > 0 && len === lastLen) stable++;
		else stable = 0;
		lastLen = len;
		// A challenge interstitial is static while it works, so its text length
		// "settles" too. Keep waiting for it to hand over to the real page.
		if (isChallengeTitle(titleParts.join("\n"))) continue;

		if (sawRealUrl && readyOk && len > 0 && stable >= 2) return;
		if (sawRealUrl && readyOk && i >= 24) return; // give up waiting for stability
	}
}

/** Titles of bot-protection interstitials that resolve on their own. Exported for testing. */
export function isChallengeTitle(title: string): boolean {
	return /^(just a moment|attention required|checking your browser|please wait|ddos-guard)\b/i.test(title.trim());
}

// --- minimal CDP client -----------------------------------------------------

/** Commands and events scoped to one flattened target session. */
interface CdpSession {
	call(method: string, params?: Record<string, unknown>): Promise<any>;
	// biome-ignore lint/suspicious/noExplicitAny: CDP event payloads are untyped
	on(method: string, handler: (params: any) => void): void;
}

interface Pending {
	resolve: (value: any) => void;
	reject: (err: Error) => void;
}

class Cdp {
	private ws!: WebSocket;
	private id = 1;
	private pending = new Map<number, Pending>();
	// biome-ignore lint/suspicious/noExplicitAny: CDP event payloads are untyped
	private handlers = new Map<string, (params: any) => void>();
	private handlerKey = (method: string, sessionId?: string) => `${sessionId ?? ""}|${method}`;
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
					return;
				}
				if (typeof msg.method === "string")
					this.handlers.get(this.handlerKey(msg.method, msg.sessionId))?.(msg.params);
			});
		});
	}

	/** Subscribe to a CDP event. One handler per method and session; last call wins. */
	// biome-ignore lint/suspicious/noExplicitAny: CDP event payloads are untyped
	on(method: string, handler: (params: any) => void, sessionId?: string): void {
		this.handlers.set(this.handlerKey(method, sessionId), handler);
	}

	call(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
		if (this.signal.aborted) return Promise.reject(new DefuddleError("Browser operation aborted"));
		const id = this.id++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
		});
	}

	/** View of this connection scoped to a flattened target session. */
	session(sessionId: string): CdpSession {
		return {
			call: (method, params) => this.call(method, params, sessionId),
			on: (method, handler) => this.on(method, handler, sessionId),
		};
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
