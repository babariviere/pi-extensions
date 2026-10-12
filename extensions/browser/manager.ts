/**
 * Owns this session's pages in the shared background browser.
 *
 * Pages are ordinary tabs in the agent's own browser instance (see
 * ../shared/browser/launch.ts), which runs hidden, so they never appear on
 * screen until `show`. They survive between tool calls over one CDP
 * connection and close on `close`, after an idle timeout, or at session end.
 */

import { execFile } from "node:child_process";
import { Cdp, CdpError, type CdpSession } from "../shared/browser/cdp.ts";
import { ensureBrowser, isChallengeTitle, navigate, sleep } from "../shared/browser/launch.ts";
import { parseKey } from "./keys.ts";
import type { BrowserSettings } from "./settings.ts";
import { REF_ATTRIBUTE, type Snapshot, snapshotExpression } from "./snapshot.ts";

export const BROWSER_ACTIONS = [
	"open",
	"navigate",
	"snapshot",
	"click",
	"type",
	"press",
	"scroll",
	"back",
	"eval",
	"screenshot",
	"list",
	"close",
	"show",
	"hide",
] as const;
export type BrowserAction = (typeof BROWSER_ACTIONS)[number];

export interface BrowserParams {
	action: BrowserAction;
	pageId?: string;
	url?: string;
	ref?: number;
	text?: string;
	submit?: boolean;
	clear?: boolean;
	key?: string;
	direction?: "up" | "down" | "left" | "right";
	amount?: number;
	expression?: string;
	fullPage?: boolean;
	snapshot?: boolean;
	maxChars?: number;
}

export interface PageSummary {
	pageId: string;
	url: string;
	title: string;
}

export interface ImageBlock {
	type: "image";
	data: string;
	mimeType: string;
}

export interface BrowserResult extends Partial<PageSummary> {
	snapshot?: Snapshot;
	/** Pages this action opened (e.g. target=_blank links), already usable by id. */
	newPages?: string[];
	/** JavaScript dialogs (alert, confirm, prompt) that were auto-accepted. */
	dialogs?: string[];
	value?: unknown;
	image?: ImageBlock;
	pages?: PageSummary[];
	closed?: string;
	note?: string;
}

interface Page {
	id: string;
	targetId: string;
	session: CdpSession;
	idleTimer?: ReturnType<typeof setTimeout>;
	newPages: string[];
	pendingPopups: Set<Promise<unknown>>;
	dialogs: string[];
}

/** Actions that change the page and return a fresh snapshot by default. */
const SNAPSHOT_BY_DEFAULT = new Set<BrowserAction>([
	"open",
	"navigate",
	"snapshot",
	"click",
	"type",
	"press",
	"scroll",
	"back",
]);

/**
 * Installed in every page before its scripts run. Popups (target=_blank links
 * and forms, window.open) would open a new window, which macOS brings on
 * screen even for a hidden app, so they navigate the current tab instead.
 */
export const SAME_TAB_SCRIPT = `(() => {
	const retarget = (el) => {
		const target = el && el.getAttribute && el.getAttribute("target");
		if (target && !["_self", "_top", "_parent"].includes(target)) el.setAttribute("target", "_top");
	};
	for (const type of ["click", "auxclick", "submit"]) {
		document.addEventListener(type, (e) => retarget(e.target instanceof Element ? e.target.closest("a[target], area[target], form[target]") : null), true);
	}
	const open = (url) => {
		if (url) {
			const href = new URL(String(url), location.href).href;
			try { window.top.location.assign(href); } catch { location.assign(href); }
		}
		return null;
	};
	Object.defineProperty(window, "open", { value: open, configurable: true, writable: true });
})()`;

export class BrowserManager {
	private cdp?: Cdp;
	private connecting?: Promise<Cdp>;
	private readonly pages = new Map<string, Page>();
	private nextPage = 1;
	private current?: string;
	private closed = false;
	/** Whether `show` put the browser on screen; new windows are tucked away otherwise. */
	private visible = false;
	/** Set once `show` ran: macOS may then un-hide the app when windows are created. */
	private revealed = false;

	constructor(private readonly settings: BrowserSettings) {}

	async run(params: BrowserParams): Promise<BrowserResult> {
		if (this.closed) throw new Error("Browser session is closed");
		switch (params.action) {
			case "open": {
				const page = await this.openPage();
				await this.navigate(page, params.url!);
				return this.finish(page, params);
			}
			case "list":
				return { pages: await this.list() };
			case "hide":
				await this.hide();
				return { note: "Browser hidden" };
		}

		const page = this.page(params.pageId);
		switch (params.action) {
			case "navigate":
				await this.navigate(page, params.url!);
				break;
			case "snapshot":
				break;
			case "click":
				return this.finish(page, params, await this.click(page, params.ref!));
			case "type":
				await this.type(page, params.ref!, params.text!, params.clear ?? true, params.submit ?? false);
				break;
			case "press":
				await this.dispatchKey(page, params.key!);
				await this.settle(page, this.settings.actionSettleMs);
				break;
			case "scroll":
				await this.scroll(page, params);
				break;
			case "back":
				await this.back(page);
				break;
			case "eval":
				return this.finish(page, params, { value: await this.evaluate(page, params.expression!, true) });
			case "screenshot":
				return this.finish(page, params, { image: await this.screenshot(page, params.fullPage ?? false) });
			case "close":
				await this.closePage(page);
				return { closed: page.id, pages: await this.list() };
			case "show":
				await this.show(page);
				return this.finish(page, params, { note: "Page shown" });
		}
		return this.finish(page, params);
	}

	/** End of session: close every page this manager opened and drop the connection. */
	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		const cdp = this.cdp;
		const pages = [...this.pages.values()];
		this.pages.clear();
		for (const page of pages) clearTimeout(page.idleTimer);
		if (cdp?.isOpen) {
			await Promise.allSettled(
				pages.map((page) =>
					cdp.call("Target.closeTarget", { targetId: page.targetId }, undefined, { timeoutMs: 2_000 }),
				),
			);
		}
		cdp?.close();
	}

	// --- connection and page registry -------------------------------------

	private async connection(): Promise<Cdp> {
		if (this.cdp?.isOpen) return this.cdp;
		this.connecting ??= this.connect().finally(() => {
			this.connecting = undefined;
		});
		return this.connecting;
	}

	private async connect(): Promise<Cdp> {
		const url = await ensureBrowser(this.settings.port);
		const cdp: Cdp = new Cdp(url, {
			callTimeoutMs: 30_000,
			onClose: () => {
				if (this.cdp !== cdp) return;
				// The browser quit or the socket dropped: those pages are gone.
				this.cdp = undefined;
				for (const page of this.pages.values()) clearTimeout(page.idleTimer);
				this.pages.clear();
			},
		});
		await cdp.connect();
		cdp.on("Target.targetCreated", (p) => this.onTargetCreated(p?.targetInfo));
		cdp.on("Target.targetDestroyed", (p) => this.forget(p?.targetId));
		await cdp.call("Target.setDiscoverTargets", { discover: true });
		this.cdp = cdp;
		return cdp;
	}

	private page(pageId?: string): Page {
		const id = pageId ?? this.current ?? (this.pages.size === 1 ? [...this.pages.keys()][0] : undefined);
		const page = id ? this.pages.get(id) : undefined;
		if (!page) {
			const open = [...this.pages.keys()];
			const known = open.length ? `Open pages: ${open.join(", ")}.` : "No pages are open; use action 'open' first.";
			throw new Error(id ? `Unknown page "${id}". ${known}` : `No page selected. ${known}`);
		}
		this.touch(page);
		return page;
	}

	private touch(page: Page): void {
		this.current = page.id;
		clearTimeout(page.idleTimer);
		page.idleTimer = setTimeout(() => void this.closePage(page).catch(() => {}), this.settings.idleTimeoutMs);
		page.idleTimer.unref?.();
	}

	private async openPage(): Promise<Page> {
		const cdp = await this.connection();
		// A normal background tab (not a hidden target), so `show` can reveal it.
		const { targetId } = await cdp.call("Target.createTarget", { url: "about:blank", background: true });
		const page = await this.attach(cdp, targetId);
		await this.keepHidden(cdp, page);
		this.touch(page);
		return page;
	}

	private async attach(cdp: Cdp, targetId: string): Promise<Page> {
		const { sessionId } = await cdp.call("Target.attachToTarget", { targetId, flatten: true });
		const session = cdp.session(sessionId);
		const page: Page = {
			id: `p${this.nextPage++}`,
			targetId,
			session,
			newPages: [],
			pendingPopups: new Set(),
			dialogs: [],
		};
		this.pages.set(page.id, page);
		// Dialogs block the page until handled; accept them and report the text.
		session.on("Page.javascriptDialogOpening", (p) => {
			page.dialogs.push(`${p?.type ?? "dialog"}: ${p?.message ?? ""}`);
			void session.call("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
		});
		await session.call("Page.enable");
		await session.call("Page.addScriptToEvaluateOnNewDocument", { source: SAME_TAB_SCRIPT });
		// The window stays hidden; focus emulation keeps timers and rendering running.
		await session.call("Emulation.setFocusEmulationEnabled", { enabled: true });
		await session.call("Emulation.setDeviceMetricsOverride", {
			...this.settings.viewport,
			deviceScaleFactor: 1,
			mobile: false,
		});
		return page;
	}

	// biome-ignore lint/suspicious/noExplicitAny: CDP payload
	private onTargetCreated(info: any): void {
		if (info?.type !== "page" || !info.openerId) return;
		const opener = [...this.pages.values()].find((p) => p.targetId === info.openerId);
		const cdp = this.cdp;
		if (!opener || !cdp) return;
		const pending = this.attach(cdp, info.targetId)
			.then(async (page) => {
				// Something still opened a window (e.g. a modifier-click): tuck it away.
				await this.keepHidden(cdp, page, true);
				this.touch(page);
				this.current = opener.id;
				opener.newPages.push(page.id);
			})
			.catch(() => {});
		opener.pendingPopups.add(pending);
		void pending.finally(() => opener.pendingPopups.delete(pending));
	}

	private forget(targetId?: string): void {
		for (const page of this.pages.values()) {
			if (page.targetId !== targetId) continue;
			clearTimeout(page.idleTimer);
			this.pages.delete(page.id);
			if (this.current === page.id) this.current = undefined;
		}
	}

	/** Keep a new page off screen unless the user asked to watch. */
	private async keepHidden(cdp: Cdp, page: Page, force = false): Promise<void> {
		if (this.visible || (!force && !this.revealed)) return;
		const win = await cdp.call("Browser.getWindowForTarget", { targetId: page.targetId }).catch(() => undefined);
		if (win?.bounds?.windowState === "normal") {
			await cdp
				.call("Browser.setWindowBounds", { windowId: win.windowId, bounds: { windowState: "minimized" } })
				.catch(() => {});
		}
		if (process.platform === "darwin") {
			await setMacAppVisible(await this.browserPid(cdp), false).catch(() => {});
		}
	}

	private async closePage(page: Page): Promise<void> {
		this.forget(page.targetId);
		await this.cdp?.call("Target.closeTarget", { targetId: page.targetId }).catch(() => {});
	}

	private async list(): Promise<PageSummary[]> {
		return Promise.all([...this.pages.values()].map((page) => this.summary(page)));
	}

	private async summary(page: Page): Promise<PageSummary> {
		const info = await this.cdp
			?.call("Target.getTargetInfo", { targetId: page.targetId })
			.then((r) => r?.targetInfo)
			.catch(() => undefined);
		return { pageId: page.id, url: info?.url ?? "", title: info?.title ?? "" };
	}

	/** Common tail: report popups and dialogs, and snapshot when wanted. */
	private async finish(page: Page, params: BrowserParams, extra: BrowserResult = {}): Promise<BrowserResult> {
		if (page.pendingPopups.size) await Promise.race([Promise.allSettled([...page.pendingPopups]), sleep(2_000)]);
		const result: BrowserResult = { ...(await this.summary(page)), ...extra };
		if (page.newPages.length) result.newPages = page.newPages.splice(0);
		if (page.dialogs.length) result.dialogs = page.dialogs.splice(0);
		if (params.snapshot ?? SNAPSHOT_BY_DEFAULT.has(params.action)) {
			result.snapshot = await this.snapshot(page, params.maxChars ?? this.settings.maxChars);
			result.url = result.snapshot.url;
			result.title = result.snapshot.title;
		}
		return result;
	}

	// --- page actions -------------------------------------------------------

	private async navigate(page: Page, rawUrl: string): Promise<void> {
		const url = normalizeUrl(rawUrl);
		const nav = await navigate(page.session, url, { timeoutMs: this.settings.navigationTimeoutMs });
		// ERR_ABORTED is expected for navigations handed off elsewhere (downloads, etc.).
		if (nav?.errorText && nav.errorText !== "net::ERR_ABORTED")
			throw new Error(`Navigation failed: ${nav.errorText}`);
		await this.settle(page, this.settings.navigationTimeoutMs);
	}

	private async back(page: Page): Promise<void> {
		const history = await page.session.call("Page.getNavigationHistory");
		const previous = history?.entries?.[history.currentIndex - 1];
		if (!previous) throw new Error("No previous page in this tab's history");
		await page.session.call("Page.navigateToHistoryEntry", { entryId: previous.id });
		await this.settle(page, this.settings.navigationTimeoutMs);
	}

	private snapshot(page: Page, maxChars: number): Promise<Snapshot> {
		return this.evaluate(page, snapshotExpression(maxChars, this.settings.maxElements)) as Promise<Snapshot>;
	}

	private async click(page: Page, ref: number): Promise<BrowserResult> {
		const target = (await this.evaluate(
			page,
			`(() => {
				const el = ${refQuery(ref)};
				if (!el) return null;
				el.scrollIntoView({ block: "center", inline: "center" });
				const r = el.getBoundingClientRect();
				const x = r.left + r.width / 2, y = r.top + r.height / 2;
				const hit = document.elementFromPoint(x, y);
				return { x, y, hit: !!hit && (hit === el || el.contains(hit) || hit.contains(el)) };
			})()`,
		)) as { x: number; y: number; hit: boolean } | null;
		if (!target) throw staleRef(ref);

		let note: string | undefined;
		if (target.hit) {
			// Real input events, so the page sees a trusted click.
			const base = { x: target.x, y: target.y, button: "left", clickCount: 1 };
			await page.session.call("Input.dispatchMouseEvent", { ...base, type: "mouseMoved", button: "none" });
			await page.session.call("Input.dispatchMouseEvent", { ...base, type: "mousePressed" });
			await page.session.call("Input.dispatchMouseEvent", { ...base, type: "mouseReleased" });
		} else {
			await this.evaluate(page, `${refQuery(ref)}.click()`);
			note = "Element was covered by another element (e.g. a banner); clicked it with element.click() instead.";
		}
		await this.settle(page, this.settings.actionSettleMs);
		return note ? { note } : {};
	}

	private async type(page: Page, ref: number, text: string, clear: boolean, submit: boolean): Promise<void> {
		const prepared = (await this.evaluate(
			page,
			`(() => {
				const el = ${refQuery(ref)};
				if (!el) return null;
				el.scrollIntoView({ block: "center" });
				if (el.tagName === "SELECT") {
					const want = ${JSON.stringify(text)};
					const options = [...el.options];
					const opt = options.find((o) => o.value === want || o.text.trim() === want)
						?? options.find((o) => o.text.toLowerCase().includes(want.toLowerCase()));
					if (!opt) return { select: true, options: options.map((o) => o.text.trim()).slice(0, 50) };
					el.value = opt.value;
					el.dispatchEvent(new Event("input", { bubbles: true }));
					el.dispatchEvent(new Event("change", { bubbles: true }));
					return { select: true, chosen: opt.text.trim() };
				}
				el.focus();
				if (${clear}) {
					if ("value" in el && typeof el.select === "function") { try { el.select(); } catch {} }
					else if (el.isContentEditable) {
						const range = document.createRange();
						range.selectNodeContents(el);
						const sel = getSelection();
						sel.removeAllRanges();
						sel.addRange(range);
					}
				}
				return { select: false };
			})()`,
		)) as { select: boolean; chosen?: string; options?: string[] } | null;
		if (!prepared) throw staleRef(ref);
		if (prepared.select && !prepared.chosen) {
			throw new Error(`No option matching ${JSON.stringify(text)}. Options: ${prepared.options?.join(" | ")}`);
		}
		if (!prepared.select) {
			if (text) await page.session.call("Input.insertText", { text });
			else if (clear) await this.dispatchKey(page, "Backspace");
		}
		if (submit) await this.dispatchKey(page, "Enter");
		await this.settle(page, this.settings.actionSettleMs);
	}

	private async dispatchKey(page: Page, spec: string): Promise<void> {
		const key = parseKey(spec);
		const base = {
			key: key.key,
			code: key.code,
			windowsVirtualKeyCode: key.keyCode,
			nativeVirtualKeyCode: key.keyCode,
			modifiers: key.modifiers,
		};
		await page.session.call(
			"Input.dispatchKeyEvent",
			key.text
				? { ...base, type: "keyDown", text: key.text, unmodifiedText: key.text }
				: { ...base, type: "rawKeyDown" },
		);
		await page.session.call("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
	}

	private async scroll(page: Page, params: BrowserParams): Promise<void> {
		if (params.ref !== undefined) {
			const found = await this.evaluate(
				page,
				`(() => { const el = ${refQuery(params.ref)}; if (!el) return false; el.scrollIntoView({ block: "center" }); return true; })()`,
			);
			if (!found) throw staleRef(params.ref);
		} else {
			const { width, height } = this.settings.viewport;
			const direction = params.direction ?? "down";
			const amount =
				params.amount ?? Math.round((direction === "left" || direction === "right" ? width : height) * 0.8);
			const sign = direction === "up" || direction === "left" ? -1 : 1;
			const vertical = direction === "up" || direction === "down";
			// A wheel event at the viewport centre also scrolls inner scroll containers.
			await page.session.call("Input.dispatchMouseEvent", {
				type: "mouseWheel",
				x: width / 2,
				y: height / 2,
				deltaX: vertical ? 0 : sign * amount,
				deltaY: vertical ? sign * amount : 0,
			});
		}
		await this.settle(page, 1_500);
	}

	private async evaluate(page: Page, expression: string, userGesture = false): Promise<unknown> {
		const r = await page.session.call("Runtime.evaluate", {
			expression,
			returnByValue: true,
			awaitPromise: true,
			userGesture,
		});
		if (r?.exceptionDetails) {
			const detail = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "unknown error";
			throw new Error(`JavaScript error: ${detail}`);
		}
		return r?.result?.value;
	}

	private async screenshot(page: Page, fullPage: boolean): Promise<ImageBlock> {
		const params: Record<string, unknown> = { format: "png" };
		if (fullPage) {
			const metrics = await page.session.call("Page.getLayoutMetrics");
			const height = Math.min(
				Math.ceil(metrics?.cssContentSize?.height ?? this.settings.viewport.height),
				this.settings.maxScreenshotHeight,
			);
			params.captureBeyondViewport = true;
			params.clip = { x: 0, y: 0, width: this.settings.viewport.width, height, scale: 1 };
		}
		const shot = await page.session.call("Page.captureScreenshot", params);
		return { type: "image", data: shot.data, mimeType: "image/png" };
	}

	/**
	 * Wait until the document is complete and its text length is stable, or the
	 * timeout passes. Bot-challenge interstitials keep it waiting.
	 */
	private async settle(page: Page, timeoutMs: number): Promise<void> {
		const start = Date.now();
		let lastLength = -1;
		let stable = 0;
		while (Date.now() - start < timeoutMs) {
			await sleep(250);
			let probe: [string, number, string] | undefined;
			try {
				probe = (
					await page.session.call(
						"Runtime.evaluate",
						{
							expression:
								"[document.readyState, ((document.body && document.body.innerText) || '').length, document.title]",
							returnByValue: true,
						},
						{ timeoutMs: 2_000 },
					)
				)?.result?.value;
			} catch {
				// Mid-navigation the context can vanish; just poll again.
			}
			if (!probe) {
				stable = 0;
				continue;
			}
			const [ready, length, title] = probe;
			stable = length === lastLength ? stable + 1 : 0;
			lastLength = length;
			if (isChallengeTitle(title)) continue;
			if (ready === "complete" && stable >= 2) return;
		}
	}

	// --- window visibility -------------------------------------------------

	private async show(page: Page): Promise<void> {
		const cdp = await this.connection();
		this.visible = true;
		this.revealed = true;
		await cdp.call("Target.activateTarget", { targetId: page.targetId });
		const { windowId } = await cdp.call("Browser.getWindowForTarget", { targetId: page.targetId });
		await cdp.call("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } }).catch(() => {});
		if (process.platform === "darwin") await setMacAppVisible(await this.browserPid(cdp), true);
	}

	private async hide(): Promise<void> {
		const cdp = await this.connection();
		this.visible = false;
		// Minimize too: once the app has been activated, macOS un-hides it when a
		// new tab is created, but tabs added to a minimized window stay put.
		for (const page of this.pages.values()) {
			const win = await cdp.call("Browser.getWindowForTarget", { targetId: page.targetId }).catch(() => undefined);
			if (win)
				await cdp
					.call("Browser.setWindowBounds", { windowId: win.windowId, bounds: { windowState: "minimized" } })
					.catch(() => {});
		}
		if (process.platform === "darwin") await setMacAppVisible(await this.browserPid(cdp), false);
	}

	private async browserPid(cdp: Cdp): Promise<number> {
		const info = await cdp.call("SystemInfo.getProcessInfo").catch(() => undefined);
		// biome-ignore lint/suspicious/noExplicitAny: CDP payload
		const pid = info?.processInfo?.find((p: any) => p.type === "browser")?.id;
		if (typeof pid === "number") return pid;
		const out = await run("/usr/sbin/lsof", ["-t", "-n", `-iTCP:${this.settings.port}`, "-sTCP:LISTEN"]);
		const fromLsof = Number.parseInt(out.trim().split("\n")[0] ?? "", 10);
		if (!Number.isFinite(fromLsof)) throw new Error("Could not find the browser process");
		return fromLsof;
	}
}

/** Accept bare hosts and http(s), file, or about: URLs. */
export function normalizeUrl(input: string): string {
	const trimmed = input.trim();
	const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
	let url: URL;
	try {
		url = new URL(withScheme);
	} catch {
		throw new Error(`Invalid URL: ${input}`);
	}
	if (!["http:", "https:", "file:", "about:"].includes(url.protocol)) {
		throw new Error(`Unsupported URL scheme: ${url.protocol}`);
	}
	return url.href;
}

function refQuery(ref: number): string {
	return `document.querySelector('[${REF_ATTRIBUTE}="${Math.trunc(ref)}"]')`;
}

function staleRef(ref: number): Error {
	return new Error(`Element [${ref}] not found. Refs change on every snapshot and navigation; take a new snapshot.`);
}

/** Unhide and activate, or hide, one app instance by pid (AppKit via JXA; no automation permission). */
function setMacAppVisible(pid: number, visible: boolean): Promise<string> {
	const action = visible ? "app.unhide; app.activateWithOptions(1);" : "app.hide;";
	const script = `ObjC.import("AppKit"); const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid}); if (app.isNil()) throw new Error("no app"); ${action}`;
	return run("/usr/bin/osascript", ["-l", "JavaScript", "-e", script]);
}

function run(file: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(file, args, { timeout: 10_000 }, (err, stdout, stderr) => {
			if (err) reject(new CdpError(`${file} failed: ${stderr || err.message}`));
			else resolve(stdout);
		});
	});
}
