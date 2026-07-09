/**
 * Tunable settings for the web extension.
 *
 * These are plain defaults. Adjust here to change behavior across both tools.
 */

export interface WebSettings {
	/** Default number of search results to return when `limit` is omitted. */
	searchLimit: number;
	/** Max number of search results allowed. */
	maxSearchLimit: number;
	/** Timeout (ms) for `git clone`. */
	gitCloneTimeout: number;
	/** Default timeout (ms) for fetch_content network requests. */
	fetchTimeout: number;
	/** Number of README lines included in a repo summary. */
	readmeHeadLines: number;
	/** Number of tree entries included in a repo summary. */
	treeHeadEntries: number;
	/**
	 * Enable the headed-Chrome CDP fallback when a direct fetch is blocked
	 * (e.g. Cloudflare challenge) or yields no content.
	 */
	browserFallback: boolean;
	/** Timeout (ms) for the browser fallback (launch + navigate + extract). */
	browserTimeout: number;
	/** CDP port for the reused background Chrome instance. */
	browserCdpPort: number;
}

export const DEFAULT_SETTINGS: WebSettings = {
	searchLimit: 10,
	maxSearchLimit: 20,
	gitCloneTimeout: 60_000,
	fetchTimeout: 30_000,
	readmeHeadLines: 40,
	treeHeadEntries: 100,
	browserFallback: true,
	browserTimeout: 45_000,
	browserCdpPort: 9333,
};
