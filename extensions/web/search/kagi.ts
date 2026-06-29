/**
 * Kagi HTML search client.
 *
 * Rides the consumer subscription via the session-token HTML endpoint
 * (`kagi.com/html/search`). No paid Search API, no per-query billing.
 * Returns ranked web links + snippets only (no quick answers).
 */

import { type DefaultTreeAdapterTypes, parse } from "parse5";
import { loadSecret } from "../utils.ts";

type ChildNode = DefaultTreeAdapterTypes.ChildNode;
type Element = DefaultTreeAdapterTypes.Element;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;
type TextNode = DefaultTreeAdapterTypes.TextNode;

export const KAGI_TOKEN_ENV = "KAGI_SESSION_TOKEN";

export interface KagiResult {
	title: string;
	url: string;
	snippet: string;
}

export class KagiTokenMissingError extends Error {
	constructor() {
		super(`Missing Kagi session token. Set ${KAGI_TOKEN_ENV} (env or ~/.pi/agent/secrets.json).`);
		this.name = "KagiTokenMissingError";
	}
}

export class KagiAuthError extends Error {
	constructor(status: number) {
		super(`Kagi rejected the request (HTTP ${status}). The session token may be invalid or expired.`);
		this.name = "KagiAuthError";
	}
}

export function getKagiToken(): string | undefined {
	return loadSecret(KAGI_TOKEN_ENV);
}

interface SearchOptions {
	limit: number;
	signal?: AbortSignal;
	/** Internal: max retry attempts on 429/5xx. */
	maxRetries?: number;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * Run a Kagi HTML search. Retries with backoff on 429/5xx.
 */
export async function kagiSearch(query: string, options: SearchOptions): Promise<KagiResult[]> {
	const token = getKagiToken();
	if (!token) throw new KagiTokenMissingError();

	const html = await fetchSearchHtml(query, token, options);
	const results = parseResults(html);
	return results.slice(0, options.limit);
}

async function fetchSearchHtml(query: string, token: string, options: SearchOptions): Promise<string> {
	const maxRetries = options.maxRetries ?? 3;
	const url = `https://kagi.com/html/search?q=${encodeURIComponent(query)}`;

	let lastError: unknown;
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			const res = await fetch(url, {
				headers: {
					Cookie: `kagi_session=${token}`,
					"User-Agent": "Mozilla/5.0 (compatible; pi-web-extension)",
					Accept: "text/html",
				},
				signal: options.signal,
			});

			if (res.ok) return await res.text();

			if (RETRYABLE_STATUS.has(res.status) && attempt < maxRetries) {
				await backoff(attempt, options.signal);
				continue;
			}
			throw new KagiAuthError(res.status);
		} catch (err) {
			if (err instanceof KagiAuthError) throw err;
			if (options.signal?.aborted) throw err;
			lastError = err;
			if (attempt < maxRetries) {
				await backoff(attempt, options.signal);
				continue;
			}
		}
	}
	throw lastError instanceof Error ? lastError : new Error("Kagi search failed");
}

function backoff(attempt: number, signal?: AbortSignal): Promise<void> {
	const delay = Math.min(2 ** attempt * 500, 4000);
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new Error("Operation aborted"));
		const timer = setTimeout(resolve, delay);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(new Error("Operation aborted"));
			},
			{ once: true },
		);
	});
}

// --- HTML parsing -----------------------------------------------------------

function isElement(node: { nodeName: string }): node is Element {
	return "tagName" in node;
}

function hasChildren(node: unknown): node is ParentNode {
	return !!node && typeof node === "object" && Array.isArray((node as ParentNode).childNodes);
}

function getAttr(el: Element, name: string): string | undefined {
	return el.attrs?.find((a) => a.name === name)?.value;
}

function classList(el: Element): string[] {
	return (getAttr(el, "class") ?? "").split(/\s+/).filter(Boolean);
}

/** Yield every Element in the subtree rooted at `node` (document, element, or fragment). */
function* walk(node: ParentNode | ChildNode): Generator<Element> {
	if (isElement(node)) yield node;
	if (hasChildren(node)) {
		for (const child of node.childNodes) {
			yield* walk(child);
		}
	}
}

function textContent(el: Element): string {
	let out = "";
	const visit = (node: ChildNode) => {
		if (node.nodeName === "#text") {
			out += (node as TextNode).value;
		} else if (isElement(node)) {
			for (const child of node.childNodes ?? []) visit(child);
		}
	};
	visit(el);
	return collapseWhitespace(out);
}

function collapseWhitespace(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

function findFirst(el: Element, predicate: (e: Element) => boolean): Element | undefined {
	for (const child of el.childNodes ?? []) {
		for (const descendant of walk(child)) {
			if (predicate(descendant)) return descendant;
		}
	}
	return undefined;
}

/**
 * Parse Kagi HTML results. Each result block carries the `search-result`
 * (a.k.a. `_0_SRI`) class; within it the title is the first anchor with a
 * usable href, and the snippet lives in a `__sri-desc` / `sri-desc` node.
 */
export function parseResults(html: string): KagiResult[] {
	const doc = parse(html);
	const results: KagiResult[] = [];
	const seen = new Set<string>();

	for (const el of walk(doc)) {
		const classes = classList(el);
		const isResult = classes.includes("search-result") || classes.includes("_0_SRI");
		if (!isResult) continue;

		const titleLink = findFirst(el, (e) => {
			if (e.tagName !== "a") return false;
			const href = getAttr(e, "href");
			if (!href) return false;
			const cls = classList(e);
			// Prefer the dedicated title link; fall back to any content anchor.
			return cls.some((c) => c.includes("title")) || isHttpHref(href);
		});
		if (!titleLink) continue;

		const url = normalizeHref(getAttr(titleLink, "href"));
		if (!url || seen.has(url)) continue;

		const title = textContent(titleLink);
		if (!title) continue;

		const descEl = findFirst(el, (e) => classList(e).some((c) => c.includes("sri-desc") || c.includes("desc")));
		const snippet = descEl ? textContent(descEl) : "";

		seen.add(url);
		results.push({ title, url, snippet });
	}

	return results;
}

function isHttpHref(href: string): boolean {
	return /^https?:\/\//i.test(href);
}

function normalizeHref(href: string | undefined): string | undefined {
	if (!href) return undefined;
	if (isHttpHref(href)) {
		// Unwrap Kagi redirect wrappers (e.g. kagi.com/...?url=<encoded>).
		try {
			const url = new URL(href);
			if (url.hostname.toLowerCase().endsWith("kagi.com")) {
				const wrapped = url.searchParams.get("url");
				if (wrapped && isHttpHref(wrapped)) return wrapped;
			}
		} catch {
			return href;
		}
		return href;
	}
	// Relative redirect wrapper: pull the url= param if present.
	const match = href.match(/[?&]url=([^&]+)/);
	if (match) {
		try {
			const decoded = decodeURIComponent(match[1]);
			return isHttpHref(decoded) ? decoded : undefined;
		} catch {
			return undefined;
		}
	}
	return undefined;
}
