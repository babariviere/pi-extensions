/**
 * browser extension for pi
 *
 * One tool, `browser`, that drives pages in the shared background browser
 * (Helium, Chrome, or Chromium with a dedicated profile; see
 * ../shared/browser/launch.ts). Pages stay open between calls and are closed at
 * session end.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BrowserManager } from "./manager.ts";
import { DEFAULT_SETTINGS } from "./settings.ts";
import { createBrowserTool } from "./tool.ts";

export default function browser(pi: ExtensionAPI): void {
	const settings = DEFAULT_SETTINGS;
	let manager = new BrowserManager(settings);

	pi.registerTool(createBrowserTool(() => manager, settings));

	pi.on("session_shutdown", async () => {
		const old = manager;
		manager = new BrowserManager(settings);
		await old.close();
	});
}
