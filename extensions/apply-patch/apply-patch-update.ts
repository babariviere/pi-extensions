// Copyright 2025 OpenAI. Licensed under Apache-2.0 (see apply-patch.LICENSE).
// Modified: TypeScript port of codex-rs/apply-patch's file_update, seek_sequence,
// and text_file. Upstream revision and attribution: apply-patch.NOTICE.

import { type ApplyPatchHunk, trimEndWhitespace, trimWhitespace } from "./apply-patch-parser.ts";

export type ApplyPatchFileUpdateMode = "normalizeToLf" | "preserveLineEndings";
type Replacement = { start: number; oldLength: number; newLines: string[] };
type SourceLine = { text: string; ending: string };

const normalize = (text: string): string =>
	trimWhitespace(text)
		.replace(/[\u2010-\u2015\u2212]/gu, "-")
		.replace(/[\u2018-\u201b]/gu, "'")
		.replace(/[\u201c-\u201f]/gu, '"')
		.replace(/[\u00a0\u2002-\u200a\u202f\u205f\u3000]/gu, " ");

const seekSequence = (
	lines: string[],
	pattern: string[],
	start: number,
	eof: boolean,
	mode: ApplyPatchFileUpdateMode,
): number => {
	if (pattern.length === 0) return start;
	if (pattern.length > lines.length) return -1;
	const last = lines.length - pattern.length;
	const first = eof ? (mode === "normalizeToLf" ? last : Math.max(last, start)) : start;
	for (const normalizeLine of [(line: string) => line, trimEndWhitespace, trimWhitespace, normalize]) {
		for (let candidate = first; candidate <= last; candidate += 1) {
			if (pattern.every((line, offset) => normalizeLine(lines[candidate + offset]!) === normalizeLine(line))) {
				return candidate;
			}
		}
	}
	return -1;
};

const computeReplacements = (
	lines: string[],
	path: string,
	hunks: ApplyPatchHunk[],
	mode: ApplyPatchFileUpdateMode,
): Replacement[] => {
	const replacements: Replacement[] = [];
	let cursor = 0;
	for (const hunk of hunks) {
		for (const anchor of hunk.anchors) {
			const location = seekSequence(lines, [anchor], cursor, false, mode);
			if (location < 0) throw new Error(`Failed to find context '${anchor}' in ${path}`);
			cursor = location + 1;
		}
		if (hunk.oldLines.length === 0) {
			const start = mode === "normalizeToLf" && lines.at(-1) === "" ? lines.length - 1 : lines.length;
			replacements.push({ start, oldLength: 0, newLines: hunk.newLines });
			continue;
		}
		let pattern = hunk.oldLines;
		let newLines = hunk.newLines;
		let start = seekSequence(lines, pattern, cursor, hunk.endOfFile, mode);
		if (start < 0 && pattern.at(-1) === "") {
			pattern = pattern.slice(0, -1);
			if (newLines.at(-1) === "") newLines = newLines.slice(0, -1);
			start = seekSequence(lines, pattern, cursor, hunk.endOfFile, mode);
		}
		if (start < 0) throw new Error(`Failed to find expected lines in ${path}:\n${hunk.oldLines.join("\n")}`);
		if (mode === "normalizeToLf") {
			replacements.push({ start, oldLength: pattern.length, newLines });
		} else {
			// Retain actual context bytes, not the potentially fuzzy patch text.
			let oldStart = 0;
			let newStart = 0;
			for (const [oldContext, newContext] of hunk.contextLineIndices) {
				if (oldContext >= pattern.length || newContext >= newLines.length) break;
				if (oldStart !== oldContext || newStart !== newContext) {
					replacements.push({
						start: start + oldStart,
						oldLength: oldContext - oldStart,
						newLines: newLines.slice(newStart, newContext),
					});
				}
				oldStart = oldContext + 1;
				newStart = newContext + 1;
			}
			if (oldStart !== pattern.length || newStart !== newLines.length) {
				replacements.push({
					start: start + oldStart,
					oldLength: pattern.length - oldStart,
					newLines: newLines.slice(newStart),
				});
			}
		}
		cursor = start + pattern.length;
	}
	// Stable sorting is significant for multiple insertions at the same index.
	return replacements.sort((left, right) => left.start - right.start);
};

/** Match all hunks against the original file, then reconstruct it in source order. */
export function applyPatchUpdate(
	content: string,
	path: string,
	hunks: ApplyPatchHunk[],
	mode: ApplyPatchFileUpdateMode,
): string {
	if (mode === "normalizeToLf") {
		let lines = content.split("\n");
		if (lines.at(-1) === "") lines.pop();
		const replacements = computeReplacements(lines, path, hunks, mode);
		for (const { start, oldLength, newLines } of replacements.reverse()) {
			// Avoid spreading an unbounded hunk into splice's argument list.
			lines = lines.slice(0, start).concat(newLines, lines.slice(start + oldLength));
		}
		if (lines.at(-1) !== "") lines.push("");
		return lines.join("\n");
	}

	const source: SourceLine[] = [];
	let preferredEnding: string | undefined;
	let cursor = 0;
	for (const match of content.matchAll(/\r\n|\r|\n/gu)) {
		const ending = match[0];
		preferredEnding ??= ending;
		source.push({ text: content.slice(cursor, match.index), ending });
		cursor = match.index + ending.length;
	}
	if (cursor < content.length) source.push({ text: content.slice(cursor), ending: "" });
	preferredEnding ??= "\n";
	const replacements = computeReplacements(
		source.map((line) => line.text),
		path,
		hunks,
		mode,
	);
	const result: SourceLine[] = [];
	cursor = 0;
	for (const { start, oldLength, newLines } of replacements) {
		for (; cursor < start; cursor += 1) result.push(source[cursor]!);
		cursor = start + oldLength;
		for (const text of newLines) result.push({ text, ending: preferredEnding });
	}
	for (; cursor < source.length; cursor += 1) result.push(source[cursor]!);
	return result.map(({ text, ending }) => text + (ending || preferredEnding)).join("");
}
