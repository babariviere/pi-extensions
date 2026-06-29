/**
 * defuddle.md client.
 *
 * Free hosted service that returns front-matter + Markdown for a URL:
 *   GET https://defuddle.md/<url>
 */

import { readTextCapped } from "../utils.ts";

export interface DefuddleResult {
	title?: string;
	date?: string;
	markdown: string;
	/** Reported content type from defuddle, when available. */
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

export async function defuddleFetch(targetUrl: string, options: DefuddleOptions): Promise<DefuddleResult> {
	const endpoint = `https://defuddle.md/${targetUrl}`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeout);
	const onAbort = () => controller.abort();
	options.signal?.addEventListener("abort", onAbort, { once: true });

	try {
		const res = await fetch(endpoint, {
			headers: {
				Accept: "text/markdown, text/plain, */*",
				"User-Agent": "Mozilla/5.0 (compatible; pi-web-extension)",
			},
			signal: controller.signal,
		});

		const contentType = res.headers.get("content-type") ?? undefined;
		if (!res.ok) {
			throw new DefuddleError(`defuddle.md returned HTTP ${res.status} for ${targetUrl}`);
		}

		const body = await readTextCapped(res);
		return { ...parseFrontmatter(body), contentType };
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
	}
}

/**
 * Parse leading YAML front-matter (title/date) and return the remaining body.
 * Falls back to treating the whole payload as Markdown.
 */
function parseFrontmatter(body: string): { title?: string; date?: string; markdown: string } {
	const match = body.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
	if (!match) return { markdown: body.trim() };

	const [, frontmatter, markdown] = match;
	const meta: Record<string, string> = {};
	for (const line of frontmatter.split("\n")) {
		const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (kv) meta[kv[1].toLowerCase()] = stripQuotes(kv[2].trim());
	}
	return {
		title: meta.title || undefined,
		date: meta.date || meta.published || undefined,
		markdown: markdown.trim(),
	};
}

function stripQuotes(s: string): string {
	return s.replace(/^["']|["']$/g, "");
}
