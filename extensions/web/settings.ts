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
}

export const DEFAULT_SETTINGS: WebSettings = {
	searchLimit: 10,
	maxSearchLimit: 20,
	gitCloneTimeout: 60_000,
	fetchTimeout: 30_000,
	readmeHeadLines: 40,
	treeHeadEntries: 100,
};
