/** Tunable defaults for the browser tool. */

export interface BrowserSettings {
	/** CDP port of the shared background browser. Keep in sync with the web extension's browserCdpPort. */
	port: number;
	/** Close a page after this long without any action on it. */
	idleTimeoutMs: number;
	/** Fixed layout viewport for every page, in CSS pixels. */
	viewport: { width: number; height: number };
	/** Upper bound for open, navigate, and back to load a page. */
	navigationTimeoutMs: number;
	/** Upper bound for the page to settle after click, type, press, and scroll. */
	actionSettleMs: number;
	/** Default cap on snapshot text. */
	maxChars: number;
	/** Cap on numbered elements per snapshot. */
	maxElements: number;
	/** Cap on full-page screenshot height, in CSS pixels. */
	maxScreenshotHeight: number;
}

export const DEFAULT_SETTINGS: BrowserSettings = {
	port: 9333,
	idleTimeoutMs: 15 * 60_000,
	viewport: { width: 1280, height: 800 },
	navigationTimeoutMs: 30_000,
	actionSettleMs: 5_000,
	maxChars: 6_000,
	maxElements: 150,
	maxScreenshotHeight: 10_000,
};
