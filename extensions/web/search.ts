/**
 * web_search tool: ranked web links + snippets via Kagi.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { renderFoldableResult } from "./render.ts";
import { kagiSearch, KagiAuthError, type KagiResult, KagiTokenMissingError } from "./search/kagi.ts";
import { DEFAULT_SETTINGS, type WebSettings } from "./settings.ts";

function formatResults(results: KagiResult[]): string {
	if (results.length === 0) return "No results found.";
	return results
		.map((r, i) => {
			const lines = [`${i + 1}. [${r.title}](${r.url})`];
			if (r.snippet) lines.push(`   ${r.snippet}`);
			return lines.join("\n");
		})
		.join("\n");
}

export function createWebSearchTool(settings: WebSettings = DEFAULT_SETTINGS) {
	return defineTool({
		name: "web_search",
		label: "web search",
		description:
			"Search the web via Kagi. Returns a ranked Markdown list of links with snippets. " +
			"Use fetch_content to read a specific result.",
		promptSnippet: "Search the web (Kagi) for ranked links",
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			limit: Type.Optional(
				Type.Number({
					description: `Number of results (1-${settings.maxSearchLimit}, default ${settings.searchLimit})`,
					minimum: 1,
					maximum: settings.maxSearchLimit,
				}),
			),
		}),
		renderCall(args, theme, context) {
			const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			text.setText(formatSearchCall(args, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			return renderFoldableResult(result, options, theme, context);
		},
		async execute(_toolCallId, params, signal) {
			const limit = clamp(params.limit ?? settings.searchLimit, 1, settings.maxSearchLimit);
			try {
				const results = await kagiSearch(params.query, { limit, signal, timeoutMs: settings.fetchTimeout });
				return { content: [{ type: "text" as const, text: formatResults(results) }], details: undefined };
			} catch (err) {
				const message =
					err instanceof KagiTokenMissingError || err instanceof KagiAuthError
						? err.message
						: `Kagi search failed: ${err instanceof Error ? err.message : String(err)}`;
				return { content: [{ type: "text" as const, text: message }], details: undefined };
			}
		},
	});
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, Math.round(value)));
}

// biome-ignore lint/suspicious/noExplicitAny: theme type is not exported
function formatSearchCall(args: { query?: string; limit?: number }, theme: any): string {
	const query = typeof args?.query === "string" ? args.query : null;
	const limit = args?.limit;
	const invalidArg = theme.fg("error", "[invalid arg]");
	let text =
		theme.fg("toolTitle", theme.bold("web search")) +
		" " +
		(query === null ? invalidArg : theme.fg("accent", `/${query}/`));
	if (limit !== undefined) text += theme.fg("toolOutput", ` limit ${limit}`);
	return text;
}
