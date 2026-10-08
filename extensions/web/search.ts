/** Web search action: ranked web links + snippets via Kagi. */

import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { kagiSearch, KagiAuthError, type KagiResult, KagiTokenMissingError } from "./search/kagi.ts";
import { DEFAULT_SETTINGS, type WebSettings } from "./settings.ts";

export const SearchOutputSchema = Type.Object({
	query: Type.String(),
	results: Type.Array(Type.Object({ title: Type.String(), url: Type.String(), snippet: Type.String() })),
	error: Type.Optional(Type.String()),
});

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

export async function searchWeb(
	params: { query: string; limit?: number },
	settings: WebSettings = DEFAULT_SETTINGS,
	signal?: AbortSignal,
): Promise<AgentToolResult<undefined>> {
	const limit = clamp(params.limit ?? settings.searchLimit, 1, settings.maxSearchLimit);
	try {
		const results = await kagiSearch(params.query, { limit, signal, timeoutMs: settings.fetchTimeout });
		return {
			content: [{ type: "text" as const, text: formatResults(results) }],
			details: undefined,
			structuredContent: { query: params.query, results: results.map((result) => ({ ...result })) },
		};
	} catch (err) {
		const message =
			err instanceof KagiTokenMissingError || err instanceof KagiAuthError
				? err.message
				: `Kagi search failed: ${err instanceof Error ? err.message : String(err)}`;
		return {
			content: [{ type: "text" as const, text: message }],
			details: undefined,
			structuredContent: { query: params.query, results: [], error: message },
			isError: true,
		};
	}
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, Math.round(value)));
}

// biome-ignore lint/suspicious/noExplicitAny: theme type is not exported
export function formatSearchCall(args: { query?: string; limit?: number }, theme: any): string {
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
