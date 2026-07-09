/**
 * Local defuddle extraction.
 *
 * Fetches a URL directly and extracts the main content as Markdown using the
 * `defuddle` library (via `defuddle/node`) with a `linkedom` DOM. This replaces
 * the previously used hosted `defuddle.md` service, which was blocked (HTTP 403)
 * by bot-protected sites.
 *
 * Because the fetch now originates from the local machine, URLs are validated
 * (http/https only, no loopback/private/link-local hosts) and redirects are
 * followed manually so each hop is re-checked, to blunt SSRF.
 */

import { Defuddle } from "defuddle/node";
import { parseHTML } from "linkedom";
import { isBlockedFetchHost, readTextCapped } from "../utils.ts";

export interface DefuddleResult {
	title?: string;
	date?: string;
	markdown: string;
	/** Reported content type of the fetched page, when available. */
	contentType?: string;
}

export class DefuddleError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DefuddleError";
	}
}

interface DefuddleOptions {
	timeout: number;
	signal?: AbortSignal;
}

const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
	"(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const MAX_REDIRECTS = 5;

export async function defuddleFetch(targetUrl: string, options: DefuddleOptions): Promise<DefuddleResult> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeout);
	const onAbort = () => controller.abort();
	options.signal?.addEventListener("abort", onAbort, { once: true });

	// A fetch that validates every URL (initial load and any redirect hop or
	// async extractor request) and carries our abort signal + a browser-like UA.
	const safeFetch = createSafeFetch(controller.signal);

	try {
		const res = await safeFetch(targetUrl, {
			headers: { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
		});

		const contentType = res.headers.get("content-type") ?? undefined;
		if (!res.ok) {
			throw new DefuddleError(`Failed to fetch ${targetUrl}: HTTP ${res.status}`);
		}

		const body = await readTextCapped(res);

		// Non-HTML payloads (plain text, markdown, JSON, ...) have no main
		// content to extract; return them verbatim.
		if (contentType && !/html/i.test(contentType)) {
			return { markdown: body.trim(), contentType };
		}

		const extracted = await extractMarkdown(body, targetUrl, safeFetch);
		return { ...extracted, contentType };
	} catch (err) {
		if (err instanceof DefuddleError) throw err;
		if (err instanceof Error && err.name === "AbortError") {
			throw new DefuddleError(`Timed out fetching ${targetUrl}`);
		}
		throw new DefuddleError(
			`Failed to extract content from ${targetUrl}: ${err instanceof Error ? err.message : String(err)}`,
		);
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
	}
}

/**
 * Extract title, date, and Markdown from an HTML string. Pure and offline:
 * `useAsync` is disabled so extraction never reaches out to third-party APIs.
 * A `fetchImpl` can still be supplied for defense in depth in case a future
 * defuddle version fetches regardless.
 */
export async function extractMarkdown(
	html: string,
	url: string,
	fetchImpl?: typeof globalThis.fetch,
): Promise<Omit<DefuddleResult, "contentType">> {
	const { document } = parseHTML(html);
	const result = await Defuddle(document, url, {
		markdown: true,
		useAsync: false,
		...(fetchImpl ? { fetch: fetchImpl } : {}),
	});
	return {
		title: result.title || undefined,
		date: result.published || undefined,
		markdown: (result.content ?? "").trim(),
	};
}

/** Reject non-http(s) schemes and internal/loopback hosts before fetching. */
function assertSafeUrl(input: string): void {
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		throw new DefuddleError(`Invalid URL: ${input}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new DefuddleError(`Unsupported URL scheme: ${url.protocol}`);
	}
	if (isBlockedFetchHost(url.hostname)) {
		throw new DefuddleError(`Refusing to fetch internal/loopback host: ${url.hostname}`);
	}
}

function createSafeFetch(signal: AbortSignal): typeof globalThis.fetch {
	return async (input, init) => {
		let target =
			typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;

		for (let hop = 0; ; hop++) {
			assertSafeUrl(target);
			const res = await fetch(target, {
				...init,
				signal,
				redirect: "manual",
				headers: {
					"User-Agent": USER_AGENT,
					"Accept-Language": "en-US,en;q=0.9",
					...((init?.headers as Record<string, string> | undefined) ?? {}),
				},
			});

			const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
			if (!location) return res;
			if (hop >= MAX_REDIRECTS) throw new DefuddleError(`Too many redirects fetching ${target}`);
			target = new URL(location, target).href;
		}
	};
}
