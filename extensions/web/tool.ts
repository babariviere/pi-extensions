/** The web extension's single public tool. */
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, defineTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { FetchOutputSchema, type FetchDetails, fetchWeb, formatFetchCall, SOURCE_LABELS } from "./fetch.ts";
import { renderFoldableResult } from "./render.ts";
import { formatSearchCall, SearchOutputSchema, searchWeb } from "./search.ts";
import { DEFAULT_SETTINGS, type WebSettings } from "./settings.ts";

export function createWebTool(settings: WebSettings = DEFAULT_SETTINGS) {
	const query = Type.String({ description: "Search query (required for search)" });
	const limit = Type.Number({
		description: `Number of search results (1-${settings.maxSearchLimit}, default ${settings.searchLimit})`,
		minimum: 1,
		maximum: settings.maxSearchLimit,
	});
	const url = Type.String({ description: "URL to fetch (required for fetch)" });
	const timeout = Type.Number({
		description: `Fetch network timeout in ms (default ${settings.fetchTimeout})`,
		minimum: 1000,
	});
	// Keep the public schema object-shaped for model providers. Validate the selected branch before execution.
	const actionParameters = Type.Union([
		Type.Object(
			{ action: Type.Literal("search"), query, limit: Type.Optional(limit) },
			{ additionalProperties: false },
		),
		Type.Object(
			{ action: Type.Literal("fetch"), url, timeout: Type.Optional(timeout) },
			{ additionalProperties: false },
		),
	]);
	const parameters = Type.Object(
		{
			action: Type.Union([Type.Literal("search"), Type.Literal("fetch")]),
			query: Type.Optional(query),
			limit: Type.Optional(limit),
			url: Type.Optional(url),
			timeout: Type.Optional(timeout),
		},
		{ additionalProperties: false },
	);
	return defineTool({
		name: "web",
		label: "web",
		namespace: { name: "web", description: "Web search and content fetching" },
		// Search only reads; fetch may create clone caches, fresh temp files, and a browser profile.
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		outputSchema: Type.Union([SearchOutputSchema, FetchOutputSchema]),
		description:
			"Search the web or fetch a URL. action='search' uses Kagi and returns ranked Markdown links " +
			"with snippets; pass query and optional limit. Use action='fetch' with url and optional timeout " +
			"to read a result as Markdown. GitHub repo URLs (root/tree/blob) are cloned locally and summarized " +
			"so you can read/grep/ls the source; raw.githubusercontent.com is fetched directly; everything " +
			"else is fetched and converted to Markdown via the defuddle library. " +
			`Fetched content is truncated to the first ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB ` +
			"(whichever is hit first); if truncated, the full content is saved to a temp file.",
		promptSnippet: "Search the web (Kagi) or fetch a URL as Markdown (clones GitHub repos for local inspection)",
		parameters,
		renderCall(args, theme, context) {
			const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			text.setText(
				args.action === "search"
					? formatSearchCall(args, theme)
					: args.action === "fetch"
						? formatFetchCall(args, theme)
						: `${theme.fg("toolTitle", theme.bold("web"))} ${theme.fg("error", "[invalid action]")}`,
			);
			return text;
		},
		renderResult(result, options, theme, context) {
			const source = (result.details as FetchDetails)?.source;
			return renderFoldableResult(result, options, theme, context, {
				sourceLabel: source ? SOURCE_LABELS[source] : undefined,
			});
		},
		async execute(_toolCallId, params, signal) {
			if (!Value.Check(parameters, params) || !Value.Check(actionParameters, params))
				throw new Error("Invalid web arguments: search requires query; fetch requires url");
			switch (params.action) {
				case "search":
					return searchWeb(params, settings, signal);
				case "fetch":
					return fetchWeb(params, settings, signal);
				default:
					throw new Error("Invalid web action: expected 'search' or 'fetch'");
			}
		},
	});
}
