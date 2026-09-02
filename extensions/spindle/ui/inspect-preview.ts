/**
 * The expand-to-inspect surfaces for `spindle_exec`: what went *in* through
 * `payloads` (π), and what the session scratchpad (τ) holds after the program.
 *
 * Both exist because the tool call as rendered was lying by omission. `payloads`
 * is the parameter a program is *told* to use for every awkward value — file
 * bodies, prompts, JSON blobs, remote scripts — and the code preview then shows
 * `π.body` with no way to see what `body` is. The one exception was a payload
 * bound to a `pi.write`, which the write preview already rendered; everything
 * else was invisible at every expansion level. τ had the same shape of problem
 * from the other end: the result text names the held keys, but their content was
 * only ever visible to the program.
 *
 * Collapsed, each surface costs one dim line naming keys and sizes. Expanded, it
 * shows bounded content. Nothing here reaches for the live store: the previews
 * travel in the persisted details, so an old transcript renders the same way it
 * did when it ran.
 *
 * This is a local module rather than an edit to `ui/spindle-render.ts`, which is
 * in the render parity set (see CONTEXT.md) and must stay free of hand edits.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { formatSessionStoreBytes } from "../session-store.ts";
import { expandHint, renderBoundedLines, safeTerminalText } from "./spindle-render.ts";

/** Keys previewed in the expanded block; the summary line still names them all. */
const MAX_EXPANDED_KEYS = 6;
/** Lines shown per payload when expanded. */
const MAX_PAYLOAD_LINES = 40;
/** Names listed on the collapsed summary line before it elides. */
const MAX_SUMMARY_KEYS = 8;
/** Hard cap on one previewed line, before the renderer wraps it. */
const MAX_LINE_CHARS = 400;

/** One τ key as carried in the persisted details. */
export interface SpindleRenderStateEntry {
	key: string;
	bytes: number;
	preview?: string;
}

const clip = (value: string): string =>
	value.length > MAX_LINE_CHARS ? `${value.slice(0, MAX_LINE_CHARS - 1)}\u2026` : value;

const summary = (
	sigil: string,
	entries: Array<{ key: string; bytes: number }>,
	expanded: boolean,
	theme: Theme,
): string => {
	const shown = entries.slice(0, MAX_SUMMARY_KEYS);
	const names = shown.map((entry) => `${entry.key} (${formatSessionStoreBytes(entry.bytes)})`).join(" \u00b7 ");
	const hidden = entries.length - shown.length;
	const elision = hidden > 0 ? ` \u00b7 +${hidden} more` : "";
	const line = theme.fg("dim", `${sigil} ${names}${elision}`);
	return expanded ? line : `${line}${theme.fg("dim", " \u00b7 ")}${expandHint(theme)}`;
};

/**
 * The `π` block for `renderCall`.
 *
 * `skipKeys` holds the payloads the write preview is already rendering while the
 * call is still composing, so the same file body is never shown twice.
 */
export const payloadInspectorLines = (input: {
	payloads: Record<string, string> | undefined;
	skipKeys?: ReadonlySet<string>;
	expanded: boolean;
	theme: Theme;
}): string[] => {
	const { payloads, expanded, theme } = input;
	if (!payloads) return [];
	const skip = input.skipKeys ?? new Set<string>();
	const entries = Object.entries(payloads)
		.filter(([key, value]) => typeof value === "string" && !skip.has(key))
		.map(([key, value]) => ({ key, value, bytes: Buffer.byteLength(value, "utf8") }));
	if (entries.length === 0) return [];

	const lines = [summary("\u03c0", entries, expanded, theme)];
	if (!expanded) return lines;

	for (const entry of entries.slice(0, MAX_EXPANDED_KEYS)) {
		const all = safeTerminalText(entry.value).split("\n");
		while (all.length > 0 && all[all.length - 1] === "") all.pop();
		const shown = all.slice(0, MAX_PAYLOAD_LINES);
		lines.push(
			theme.fg("muted", `\u03c0.${entry.key}`) +
				theme.fg(
					"dim",
					` \u00b7 ${formatSessionStoreBytes(entry.bytes)} \u00b7 ${all.length} ${all.length === 1 ? "line" : "lines"}`,
				),
		);
		for (const line of shown) lines.push(theme.fg("toolOutput", clip(line) || " "));
		const hidden = all.length - shown.length;
		if (hidden > 0) lines.push(theme.fg("dim", `  \u2026 ${hidden} more ${hidden === 1 ? "line" : "lines"}`));
	}
	const hiddenKeys = entries.length - Math.min(entries.length, MAX_EXPANDED_KEYS);
	if (hiddenKeys > 0) {
		lines.push(theme.fg("dim", `\u2026 ${hiddenKeys} more payload${hiddenKeys === 1 ? "" : "s"}`));
	}
	return lines;
};

/** The `τ` block for `renderResult`: what the scratchpad holds after the run. */
export const stateInspectorLines = (input: {
	entries: SpindleRenderStateEntry[] | undefined;
	expanded: boolean;
	theme: Theme;
}): string[] => {
	const { entries, expanded, theme } = input;
	if (!entries || entries.length === 0) return [];

	const lines = [summary("\u03c4", entries, expanded, theme)];
	if (!expanded) return lines;

	for (const entry of entries.slice(0, MAX_EXPANDED_KEYS)) {
		const header =
			theme.fg("muted", `\u03c4.${entry.key}`) + theme.fg("dim", ` \u00b7 ${formatSessionStoreBytes(entry.bytes)}`);
		lines.push(header);
		if (entry.preview) lines.push(theme.fg("toolOutput", clip(safeTerminalText(entry.preview))));
	}
	const hiddenKeys = entries.length - Math.min(entries.length, MAX_EXPANDED_KEYS);
	if (hiddenKeys > 0) lines.push(theme.fg("dim", `\u2026 ${hiddenKeys} more key${hiddenKeys === 1 ? "" : "s"}`));
	return lines;
};

const componentOf = (lines: string[], theme: Theme): Component | null =>
	lines.length === 0 ? null : renderBoundedLines(lines, theme);

export const renderPayloadInspector = (input: {
	payloads: Record<string, string> | undefined;
	skipKeys?: ReadonlySet<string>;
	expanded: boolean;
	theme: Theme;
}): Component | null => componentOf(payloadInspectorLines(input), input.theme);

export const renderStateInspector = (input: {
	entries: SpindleRenderStateEntry[] | undefined;
	expanded: boolean;
	theme: Theme;
}): Component | null => componentOf(stateInspectorLines(input), input.theme);
