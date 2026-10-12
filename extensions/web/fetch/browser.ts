/**
 * Tier 2 fallback: fetch a page through a real, headed Chromium browser driven
 * over the DevTools Protocol, for sites that block a plain fetch (e.g.
 * Cloudflare's "Just a moment..." managed challenge, which detects headless
 * browsers).
 *
 * Approach (after antirez's ds4_web.c): reuse the shared background browser
 * (see ../../shared/browser/launch.ts) and open each page as a hidden target
 * that never appears in a tab strip or window. Focus emulation keeps the page
 * running the challenge JS. The rendered outerHTML is then handed to the same
 * defuddle extractor as Tier 1.
 */

import { Cdp, type CdpSession } from "../../shared/browser/cdp.ts";
import { ensureBrowser, isChallengeTitle, navigate, sleep } from "../../shared/browser/launch.ts";
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
	const cdp = new Cdp(browserWsUrl, { signal });
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
		const nav = await navigate(page, url);
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
