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

	for (const [index, entry] of entries.slice(0, MAX_EXPANDED_KEYS).entries()) {
		const all = safeTerminalText(entry.value).split("\n");
		while (all.length > 0 && all[all.length - 1] === "") all.pop();
		const shown = all.slice(0, MAX_PAYLOAD_LINES);
		// A blank line and a bold key: with several payloads in a row, the header
		// is the only thing separating one body from the next.
		if (index > 0) lines.push("");
		lines.push(
			theme.fg("toolTitle", theme.bold(`\u03c0.${entry.key}`)) +
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

const componentOf = (lines: string[], theme: Theme): Component | null =>
	lines.length === 0 ? null : renderBoundedLines(lines, theme);

export const renderPayloadInspector = (input: {
	payloads: Record<string, string> | undefined;
	skipKeys?: ReadonlySet<string>;
	expanded: boolean;
	theme: Theme;
}): Component | null => componentOf(payloadInspectorLines(input), input.theme);

/**
 * One τ operation as reported by the live execution (see `host-calls.ts`
 * `SpindleStateNote`). Redeclared structurally rather than imported so the
 * renderer keeps no dependency on the execution side.
 */
export interface SpindleStateNoteView {
	ref: string;
	key?: string;
	preview?: string;
	detail?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Reads τ notes off a *partial* tool-update payload.
 *
 * They arrive on the live channel only: the stored value must not reach the
 * durable trace (audit/projection.ts keeps the key and the size, nothing else),
 * so this is the same route the write previews take.
 */
export const readSpindleStateNotes = (value: unknown): SpindleStateNoteView[] => {
	if (!isRecord(value) || !Array.isArray(value.stateNotes)) return [];
	return value.stateNotes.filter(
		(note): note is SpindleStateNoteView => isRecord(note) && typeof note.ref === "string",
	);
};

/**
 * Fills in the body of each τ row from the notes captured while the program ran.
 *
 * The trace gives every operation a row and its key; the value lives only here.
 * Notes are consumed in order, which is safe because the trace records τ
 * operations in the order they happened. A reloaded transcript has no notes, so
 * the rows keep their key and size and simply show no value.
 */
export const applySpindleStateNotes = <T extends { ref: string; result?: unknown }>(
	audits: T[],
	notes: SpindleStateNoteView[] | undefined,
): T[] => {
	if (!notes || notes.length === 0) return audits;
	const queue = [...notes];
	return audits.map((audit) => {
		if (!audit.ref.startsWith("spindle.state.")) return audit;
		const note = queue.shift();
		const body = note?.preview ?? note?.detail;
		return body === undefined ? audit : { ...audit, result: body };
	});
};
