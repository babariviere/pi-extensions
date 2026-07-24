/**
 * fetch_content tool.
 *
 * Dispatch order:
 *   1. GitHub repo URL (root / tree / blob) -> clone + reuse, return summary.
 *   2. raw.githubusercontent.com           -> fetch raw bytes directly.
 *   3. Anything else                        -> fetch + local defuddle -> Markdown.
 *      When that is blocked or empty, fall back to a headed-Chrome CDP fetch.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	defineTool,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { browserFetch } from "./fetch/browser.ts";
import { defuddleFetch, DefuddleError, type DefuddleResult } from "./fetch/defuddle.ts";
import { renderFoldableResult } from "./render.ts";
import { DEFAULT_SETTINGS, type WebSettings } from "./settings.ts";
import { cloneCachePath, type GitHubRepoRef, isRawGitHubUrl, parseGitHubRepoUrl, readTextCapped } from "./utils.ts";

/** How the content was obtained. Human-only; never shown to the model. */
type FetchSource = "defuddle" | "browser" | "raw" | "github";

type FetchDetails = { source: FetchSource } | undefined;

type TextResult = { content: { type: "text"; text: string }[]; details: FetchDetails };

const SOURCE_LABELS: Record<FetchSource, string> = {
	defuddle: "via defuddle",
	browser: "via browser (headed Chrome)",
	raw: "via raw fetch",
	github: "via git clone",
};

// isError is not part of AgentToolResult and is ignored by the runtime for
// defineTool tools; failure context is carried in the message text itself.
function text(body: string, details: FetchDetails = undefined): TextResult {
	return { content: [{ type: "text", text: body }], details };
}

/**
 * Return fetched content, truncating from the head when it exceeds the standard
 * tool limits (2000 lines or 50KB, whichever is hit first). When truncated, the
 * full content is written to a temp file and its path is appended in a footer so
 * the model can read the rest with the read tool.
 */
function cappedText(body: string, details: FetchDetails = undefined): TextResult {
	const result = truncateHead(body);
	if (!result.truncated) return text(body, details);

	const id = randomBytes(8).toString("hex");
	const fullOutputPath = join(tmpdir(), `pi-fetch-${id}.md`);
	try {
		writeFileSync(fullOutputPath, body);
	} catch {
		// If we cannot persist the full content, still return the truncated view.
		return text(result.content, details);
	}

	const footer =
		result.truncatedBy === "lines"
			? `[Showing lines 1-${result.outputLines} of ${result.totalLines}. Full content: ${fullOutputPath}]`
			: `[Showing first ${formatSize(result.outputBytes)} of ${formatSize(result.totalBytes)} (${formatSize(
					result.maxBytes ?? DEFAULT_MAX_BYTES,
				)} limit). Full content: ${fullOutputPath}]`;
	return text(`${result.content}\n\n${footer}`, details);
}

export function createFetchContentTool(settings: WebSettings = DEFAULT_SETTINGS) {
	return defineTool({
		name: "fetch_content",
		label: "fetch content",
		description:
			"Fetch a URL as Markdown. GitHub repo URLs (root/tree/blob) are cloned locally and summarized " +
			"so you can read/grep/ls the source; raw.githubusercontent.com is fetched directly; everything " +
			"else is fetched and converted to Markdown via the defuddle library. " +
			`Content is truncated to the first ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB ` +
			"(whichever is hit first); if truncated, the full content is saved to a temp file.",
		promptSnippet: "Fetch a URL as Markdown (clones GitHub repos for local inspection)",
		parameters: Type.Object({
			url: Type.String({ description: "URL to fetch" }),
			timeout: Type.Optional(
				Type.Number({
					description: `Network timeout in ms (default ${settings.fetchTimeout})`,
					minimum: 1000,
				}),
			),
		}),
		renderCall(args, theme, context) {
			const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			text.setText(formatFetchCall(args, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const source = (result.details as FetchDetails)?.source;
			const sourceLabel = source ? SOURCE_LABELS[source] : undefined;
			return renderFoldableResult(result, options, theme, context, { sourceLabel });
		},
		async execute(_toolCallId, params, signal) {
			const timeout = params.timeout ?? settings.fetchTimeout;
			const url = params.url.trim();

			const repoRef = parseGitHubRepoUrl(url);
			if (repoRef) {
				const summary = await tryCloneAndSummarize(repoRef, settings, signal);
				if (summary) return text(summary, { source: "github" });
				// Private/unreachable repo: fall through to defuddle on the URL.
			}

			if (isRawGitHubUrl(url)) {
				return await fetchRaw(url, timeout, signal);
			}

			return await fetchViaDefuddle(url, timeout, settings, signal);
		},
	});
}

// biome-ignore lint/suspicious/noExplicitAny: theme type is not exported
function formatFetchCall(args: { url?: string; timeout?: number }, theme: any): string {
	const url = typeof args?.url === "string" ? args.url.trim() : null;
	const invalidArg = theme.fg("error", "[invalid arg]");
	return (
		theme.fg("toolTitle", theme.bold("fetch content")) +
		" " +
		(url === null ? invalidArg : theme.fg("accent", url))
	);
}

// --- defuddle path ----------------------------------------------------------

async function fetchViaDefuddle(
	url: string,
	timeout: number,
	settings: WebSettings,
	signal?: AbortSignal,
): Promise<TextResult> {
	try {
		const result = await defuddleFetch(url, { timeout, signal });
		// Direct fetch reached the page but got nothing extractable (e.g. a
		// JS-rendered shell): try the browser before giving up.
		if (!result.markdown && settings.browserFallback) {
			const viaBrowser = await escalateToBrowser(url, settings, signal);
			if (viaBrowser?.markdown) return renderDefuddle(viaBrowser, "browser");
		}
		return renderDefuddle(result, "defuddle");
	} catch (err) {
		// Direct fetch was blocked (e.g. Cloudflare 403): try the browser.
		if (settings.browserFallback) {
			const viaBrowser = await escalateToBrowser(url, settings, signal);
			if (viaBrowser?.markdown) return renderDefuddle(viaBrowser, "browser");
		}
		const message =
			err instanceof DefuddleError
				? err.message
				: `fetch_content failed: ${err instanceof Error ? err.message : String(err)}`;
		return text(message);
	}
}

function renderDefuddle(result: DefuddleResult, source: FetchSource): TextResult {
	const header: string[] = [];
	if (result.title) header.push(`# ${result.title}`);
	if (result.date) header.push(`*${result.date}*`);
	const meta = header.join("\n");

	if (!result.markdown) {
		const note = result.contentType
			? `No extractable content (content-type: ${result.contentType}).`
			: "No extractable content.";
		return text(meta ? `${meta}\n\n${note}` : note, { source });
	}

	const body = meta ? `${meta}\n\n${result.markdown}` : result.markdown;
	return cappedText(body, { source });
}

/** Attempt the browser fallback, swallowing failures so the caller can degrade. */
async function escalateToBrowser(
	url: string,
	settings: WebSettings,
	signal?: AbortSignal,
): Promise<DefuddleResult | null> {
	try {
		return await browserFetch(url, {
			timeout: settings.browserTimeout,
			port: settings.browserCdpPort,
			signal,
		});
	} catch {
		return null;
	}
}

// --- raw github path --------------------------------------------------------

async function fetchRaw(url: string, timeout: number, signal?: AbortSignal): Promise<TextResult> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeout);
	const onAbort = () => controller.abort();
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const res = await fetch(url, {
			headers: { "User-Agent": "Mozilla/5.0 (compatible; pi-web-extension)" },
			signal: controller.signal,
		});
		if (!res.ok) return text(`Failed to fetch raw content: HTTP ${res.status}`);
		const contentType = res.headers.get("content-type") ?? "unknown";
		if (/^image\/|application\/octet-stream|application\/pdf/i.test(contentType)) {
			return text(`Binary content (content-type: ${contentType}); not rendered. URL: ${url}`, { source: "raw" });
		}
		const body = await readTextCapped(res);
		return cappedText(body, { source: "raw" });
	} catch (err) {
		return text(`Failed to fetch raw content: ${err instanceof Error ? err.message : String(err)}`);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}

// --- github clone path ------------------------------------------------------

/**
 * Clone (or reuse) a repo and return a summary. Returns null on clone failure
 * so the caller can fall back to defuddle.
 */
async function tryCloneAndSummarize(
	ref: GitHubRepoRef,
	settings: WebSettings,
	signal?: AbortSignal,
): Promise<string | null> {
	const dir = cloneCachePath(ref);
	const reused = existsSync(join(dir, ".git"));

	if (!reused) {
		const ok = await gitClone(ref.cloneUrl, dir, settings.gitCloneTimeout, signal);
		if (!ok) return null;
	}

	return buildRepoSummary(ref, dir, reused, settings);
}

function gitClone(cloneUrl: string, dir: string, timeout: number, signal?: AbortSignal): Promise<boolean> {
	return new Promise((resolve) => {
		// Args passed as an array: no shell, no interpolation.
		const child = spawn("git", ["clone", "--depth", "1", "--", cloneUrl, dir], {
			stdio: "ignore",
		});
		const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
		const onAbort = () => child.kill("SIGKILL");
		signal?.addEventListener("abort", onAbort, { once: true });

		child.on("error", () => {
			cleanup();
			resolve(false);
		});
		child.on("close", (code) => {
			cleanup();
			resolve(code === 0);
		});

		function cleanup() {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
	});
}

function buildRepoSummary(ref: GitHubRepoRef, dir: string, reused: boolean, settings: WebSettings): string {
	const parts: string[] = [];
	parts.push(`# ${ref.owner}/${ref.repo}`);
	parts.push(reused ? `Reused existing clone at \`${dir}\`.` : `Cloned to \`${dir}\`.`);

	const tree = listTree(dir, settings.treeHeadEntries);
	if (tree.length > 0) {
		parts.push("\n## Top-level entries");
		parts.push(tree.map((e) => `- ${e}`).join("\n"));
	}

	const readme = readReadmeHead(dir, settings.readmeHeadLines);
	if (readme) {
		parts.push("\n## README (head)");
		parts.push(readme);
	}

	parts.push(`\nUse read/grep/ls on \`${dir}\` to inspect the source.`);
	return parts.join("\n");
}

function listTree(dir: string, max: number): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((e) => e.name !== ".git")
			.sort((a, b) => {
				if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
				return a.name.localeCompare(b.name);
			})
			.slice(0, max)
			.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
	} catch {
		return [];
	}
}

const README_CANDIDATES = ["README.md", "README.MD", "Readme.md", "readme.md", "README", "README.rst", "README.txt"];

function readReadmeHead(dir: string, maxLines: number): string | undefined {
	for (const name of README_CANDIDATES) {
		const path = join(dir, name);
		if (!existsSync(path)) continue;
		try {
			const lines = readFileSync(path, "utf8").split("\n").slice(0, maxLines);
			return lines.join("\n").trim();
		} catch {
			return undefined;
		}
	}
	return undefined;
}
