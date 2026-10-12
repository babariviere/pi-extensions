/** The browser extension's single public tool. */
import { defineTool, truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { BrowserManager, BrowserParams, BrowserResult } from "./manager.ts";
import type { BrowserSettings } from "./settings.ts";
import { formatSnapshot } from "./snapshot.ts";

const REQUIRED: Partial<Record<BrowserParams["action"], (keyof BrowserParams)[]>> = {
	open: ["url"],
	navigate: ["url"],
	click: ["ref"],
	type: ["ref", "text"],
	press: ["key"],
	eval: ["expression"],
};

/** Per-action required arguments. Returns an error message, or undefined when valid. */
export function missingArguments(params: BrowserParams): string | undefined {
	const missing = (REQUIRED[params.action] ?? []).filter((name) => params[name] === undefined);
	return missing.length ? `browser ${params.action} requires ${missing.join(", ")}` : undefined;
}

export function createBrowserTool(getManager: () => BrowserManager, settings: BrowserSettings) {
	const parameters = Type.Object(
		{
			action: Type.Union(
				[
					Type.Literal("open"),
					Type.Literal("navigate"),
					Type.Literal("snapshot"),
					Type.Literal("click"),
					Type.Literal("type"),
					Type.Literal("press"),
					Type.Literal("scroll"),
					Type.Literal("back"),
					Type.Literal("eval"),
					Type.Literal("screenshot"),
					Type.Literal("list"),
					Type.Literal("close"),
					Type.Literal("show"),
					Type.Literal("hide"),
				],
				{ description: "Action to run" },
			),
			pageId: Type.Optional(
				Type.String({ description: "Page id from open or list. Defaults to the most recently used page." }),
			),
			url: Type.Optional(Type.String({ description: "URL for open and navigate (bare hosts get https://)" })),
			ref: Type.Optional(
				Type.Integer({ minimum: 1, description: "Element number from the latest snapshot (click, type, scroll)" }),
			),
			text: Type.Optional(Type.String({ description: "Text to type, or the option to pick in a <select>" })),
			clear: Type.Optional(Type.Boolean({ description: "type: replace the current value (default true)" })),
			submit: Type.Optional(Type.Boolean({ description: "type: press Enter afterwards" })),
			key: Type.Optional(
				Type.String({ description: "press: a key like Enter, Escape, Tab, ArrowDown, a, or Control+a" }),
			),
			direction: Type.Optional(
				Type.Union([Type.Literal("up"), Type.Literal("down"), Type.Literal("left"), Type.Literal("right")], {
					description: "scroll direction (default down)",
				}),
			),
			amount: Type.Optional(
				Type.Number({ minimum: 1, description: "scroll distance in pixels (default 80% of the viewport)" }),
			),
			expression: Type.Optional(Type.String({ description: "eval: JavaScript expression; promises are awaited" })),
			fullPage: Type.Optional(
				Type.Boolean({ description: "screenshot: capture the whole page, not just the viewport" }),
			),
			snapshot: Type.Optional(
				Type.Boolean({
					description: "Include a page snapshot in the result (default true for page-changing actions)",
				}),
			),
			maxChars: Type.Optional(
				Type.Integer({
					minimum: 100,
					maximum: 100_000,
					description: `Snapshot text cap (default ${settings.maxChars})`,
				}),
			),
		},
		{ additionalProperties: false },
	);

	return defineTool({
		name: "browser",
		label: "browser",
		namespace: { name: "browser", description: "Drive a background browser: open pages, read, click, type" },
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		outputSchema: Type.Object({}, { additionalProperties: true }),
		description:
			"Control a real browser (a separate, hidden Helium/Chrome instance with its own profile) to navigate " +
			"interactive pages. Prefer the web tool for simply reading a page. Pages persist between calls and close " +
			`after ${Math.round(settings.idleTimeoutMs / 60_000)} idle minutes or at session end. ` +
			"open(url) returns a pageId and a snapshot: page text plus numbered interactive elements [n]. " +
			"Use click(ref), type(ref, text, submit?), press(key), scroll(direction|ref), navigate(url), back to act; " +
			"page-changing actions return a fresh snapshot, and refs are only valid for the latest snapshot. " +
			"eval(expression) runs JavaScript, screenshot(fullPage?) returns an image, list shows open pages, close " +
			"closes one. show brings a page on screen so the user can watch or help (e.g. a CAPTCHA); hide hides " +
			"the browser again. pageId defaults to the most recently used page.",
		promptSnippet: "Drive a hidden browser: open pages, read snapshots, click, type, screenshot",
		parameters,
		async execute(_toolCallId, params, signal) {
			if (!Value.Check(parameters, params)) throw new Error("Invalid browser arguments");
			const args = params as BrowserParams;
			const missing = missingArguments(args);
			if (missing) throw new Error(missing);
			const result = await abortable(getManager().run(args), signal);
			return toToolResult(args.action, result);
		},
	});
}

/** Model-facing text, plus the image for screenshots. Scripts get the structured result. */
export function toToolResult(action: BrowserParams["action"], result: BrowserResult) {
	const lines: string[] = [];
	if (result.pageId)
		lines.push(`Page ${result.pageId}${result.snapshot ? "" : `: ${result.title || "(untitled)"} <${result.url}>`}`);
	if (result.closed) lines.push(`Closed ${result.closed}`);
	if (result.note) lines.push(result.note);
	if (result.newPages?.length) lines.push(`Opened new page(s): ${result.newPages.join(", ")}`);
	if (result.dialogs?.length) lines.push(`Accepted dialog(s): ${result.dialogs.join(" / ")}`);
	if (result.pages) {
		lines.push(result.pages.length ? "Open pages:" : "No open pages.");
		for (const p of result.pages) lines.push(`- ${p.pageId}: ${p.title || "(untitled)"} <${p.url}>`);
	}
	if (action === "eval")
		lines.push("Result:", result.value === undefined ? "undefined" : JSON.stringify(result.value, null, 2));
	if (result.snapshot) lines.push("", formatSnapshot(result.snapshot));

	const preview = truncateHead(lines.join("\n"));
	const text = preview.truncated
		? `${preview.content}\n[Output truncated. Use codemode to read the structured result.]`
		: preview.content;
	const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [
		{ type: "text", text },
	];
	if (result.image) content.push(result.image);
	// JSON round trip: plain data only, and undefined fields dropped.
	return { content, details: undefined, structuredContent: JSON.parse(JSON.stringify(result)) };
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(new Error("Browser action aborted"));
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(new Error("Browser action aborted"));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}
