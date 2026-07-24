/**
 * Shared TUI rendering for the web tools.
 *
 * Renders a tool's text output as a folded preview by default (like the bash
 * tool) and the full content when the row is expanded (Ctrl+O). An optional
 * human-only source label (e.g. "via browser") can be shown on the first line;
 * it lives in the rendered view only and is never part of the model-visible
 * `content`.
 */

import { keyHint } from "@earendil-works/pi-coding-agent";
import { Container, Text, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/** Number of visual lines shown in the folded preview. */
const PREVIEW_LINES = 12;

interface RenderableResult {
	content?: { type: string; text?: string }[];
	details?: unknown;
}

interface RenderOptions {
	expanded?: boolean;
	isPartial?: boolean;
}

interface FoldableOptions {
	/** Human-only label shown above the output (e.g. "via browser"). */
	sourceLabel?: string;
}

function extractText(result: RenderableResult): string {
	return (result.content ?? [])
		.filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
		.map((c) => c.text)
		.join("\n");
}

export function renderFoldableResult(
	result: RenderableResult,
	options: RenderOptions,
	// biome-ignore lint/suspicious/noExplicitAny: theme type is not exported
	theme: any,
	// biome-ignore lint/suspicious/noExplicitAny: render context type is not exported
	context: any,
	opts: FoldableOptions = {},
): Container {
	const container = context?.lastComponent instanceof Container ? context.lastComponent : new Container();
	container.clear();

	if (opts.sourceLabel) {
		container.addChild(new Text(theme.fg("muted", opts.sourceLabel), 0, 0));
	}

	const body = extractText(result).trim();
	if (!body) return container;

	const styled = body
		.split("\n")
		.map((line) => theme.fg("toolOutput", line))
		.join("\n");

	if (options.expanded) {
		container.addChild(new Text(`\n${styled}`, 0, 0));
		return container;
	}

	// Folded preview: show the first PREVIEW_LINES visual lines and a hint.
	const state = context.state ?? {};
	container.addChild({
		render: (width: number) => {
			if (state.foldLines === undefined || state.foldWidth !== width) {
				const visual = width > 0 ? wrapTextWithAnsi(styled, width) : styled.split("\n");
				state.foldLines = visual.slice(0, PREVIEW_LINES);
				state.foldSkipped = Math.max(0, visual.length - PREVIEW_LINES);
				state.foldWidth = width;
			}
			const lines: string[] = state.foldLines ?? [];
			if (state.foldSkipped && state.foldSkipped > 0) {
				const hint =
					theme.fg("muted", `... (${state.foldSkipped} more lines, `) +
					keyHint("app.tools.expand", "to expand") +
					theme.fg("muted", ")");
				return ["", ...lines, hint];
			}
			return ["", ...lines];
		},
		invalidate: () => {
			state.foldWidth = undefined;
			state.foldLines = undefined;
			state.foldSkipped = undefined;
		},
	});

	return container;
}
