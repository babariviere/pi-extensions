/**
 * Fetch policy helpers: when a failed direct fetch is worth retrying through a
 * real browser, and when a page that "succeeded" is actually a not-found stub.
 */

/**
 * Statuses where a direct-fetch failure signals bot protection or a transient
 * server problem, so re-fetching through headed Chrome can plausibly succeed.
 */
const BROWSER_RETRY_STATUSES = new Set([
	403, // Cloudflare / WAF block
	406, // Not Acceptable, often UA sniffing
	408, // Request Timeout
	425, // Too Early
	429, // rate limited
	451, // Unavailable For Legal Reasons (sometimes geo-gating)
]);

/**
 * Client errors like 404, 410, and 401 are conclusive: the page is missing or
 * gated, and rendering it in Chrome only yields the site's own error page,
 * which would then be returned as if it were real content.
 */
export function shouldEscalateToBrowser(status: number | undefined): boolean {
	// No status: network error, DNS failure, TLS problem, or timeout.
	if (status === undefined) return true;
	// 5xx, including Cloudflare's 520-527 family.
	if (status >= 500) return true;
	return BROWSER_RETRY_STATUSES.has(status);
}

/**
 * Soft 404: HTTP 200 with a "page not found" placeholder body. Common on SPAs,
 * doc sites, and CDNs that serve their error page with a success status.
 *
 * Patterns are matched against the title and the first heading only, never the
 * body, so an article *about* 404s is not misclassified. The length cap keeps
 * long pages out of scope entirely.
 */
const NOT_FOUND_PATTERNS = [
	/\b404\b/,
	/\b410\b/,
	/page not found/i,
	/not found/i,
	/no longer (?:exists|available)/i,
	/does ?n[o'\u2019]?t exist/i,
	/page (?:has been |was )?(?:moved|removed|deleted)/i,
];

const SOFT_404_MAX_CHARS = 600;

export function isSoftNotFound(result: { title?: string; markdown: string }): boolean {
	if (result.markdown.length > SOFT_404_MAX_CHARS) return false;
	const heading = result.markdown.match(/^#{1,6}\s+(.+)$/m)?.[1] ?? "";
	const haystack = `${result.title ?? ""}\n${heading}`;
	if (!haystack.trim()) return false;
	return NOT_FOUND_PATTERNS.some((pattern) => pattern.test(haystack));
}
