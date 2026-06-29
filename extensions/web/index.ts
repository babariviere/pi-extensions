/**
 * web extension for pi
 *
 * Two tools:
 *   - web_search    : ranked web links + snippets via Kagi (consumer session token).
 *   - fetch_content : URL -> Markdown (defuddle.md), with a git-repo fast path
 *                     that clones + summarizes instead of scraping.
 *
 * Command:
 *   - /kagi-status  : validate the Kagi session token.
 *
 * Config / secrets:
 *   - KAGI_SESSION_TOKEN via env or ~/.pi/agent/secrets.json (or injected by the secrets extension).
 *
 * Install:
 *   Add to ~/.pi/agent/settings.json: { "extensions": ["/path/to/web"] }
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createFetchContentTool } from "./fetch.ts";
import { createWebSearchTool } from "./search.ts";
import { getKagiToken, kagiSearch } from "./search/kagi.ts";
import { DEFAULT_SETTINGS } from "./settings.ts";

export default function (pi: ExtensionAPI) {
	const settings = DEFAULT_SETTINGS;

	pi.registerTool(createWebSearchTool(settings));
	pi.registerTool(createFetchContentTool(settings));

	pi.registerCommand("kagi-status", {
		description: "Validate the Kagi session token used by web_search",
		handler: async (_args, ctx) => {
			const token = getKagiToken();
			if (!token) {
				ctx.ui.notify(
					"No Kagi token found. Set KAGI_SESSION_TOKEN via env or ~/.pi/agent/secrets.json.",
					"error",
				);
				return;
			}

			ctx.ui.notify("Validating Kagi token...", "info");
			try {
				const results = await kagiSearch("kagi search test", { limit: 1, signal: ctx.signal });
				ctx.ui.notify(
					`Kagi token OK (token …${token.slice(-4)}). Test query returned ${results.length} result(s).`,
					"info",
				);
			} catch (err) {
				ctx.ui.notify(`Kagi token check failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});
}
