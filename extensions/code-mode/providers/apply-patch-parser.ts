// Copyright 2025 OpenAI. Licensed under Apache-2.0 (see apply-patch.LICENSE).
// Modified: TypeScript port of codex-rs/apply-patch's parser and streaming parser.
// Upstream revision and attribution: apply-patch.NOTICE.

export interface ApplyPatchHunk {
	anchors: string[];
	oldLines: string[];
	newLines: string[];
	contextLineIndices: Array<[number, number]>;
	endOfFile: boolean;
	line: number;
}

export type ApplyPatchAction =
	| { kind: "add"; path: string; content: string; line: number }
	| { kind: "delete"; path: string; line: number }
	| { kind: "update"; path: string; moveTo?: string; hunks: ApplyPatchHunk[]; line: number };

// Rust str::trim uses Unicode White_Space, unlike JavaScript trim (BOM, NEL).
export const trimWhitespace = (text: string): string => text.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
export const trimEndWhitespace = (text: string): string => text.replace(/\p{White_Space}+$/u, "");

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const EOF = "*** End of File";
const ENVIRONMENT = "*** Environment ID:";
const MOVE = "*** Move to: ";

const invalidPatch = (message: string): never => {
	throw new Error(`invalid patch: ${message}`);
};
const invalidHunk = (line: number, message: string): never => {
	throw new Error(`invalid hunk at line ${line}, ${message}`);
};
const unexpectedLine = (line: string): string =>
	`Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`;
const emptyHunk = (line: number): ApplyPatchHunk => ({
	anchors: [],
	oldLines: [],
	newLines: [],
	contextLineIndices: [],
	endOfFile: false,
	line,
});
const isEmpty = (hunk: ApplyPatchHunk): boolean => hunk.oldLines.length === 0 && hunk.newLines.length === 0;

/** Parse Codex's lenient V4A envelope without touching the filesystem. */
export function parseApplyPatch(patch: string): ApplyPatchAction[] {
	if (typeof patch !== "string") throw new Error("pi.applyPatch patch must be a string");
	let lines = trimWhitespace(patch).split(/\r?\n/);
	const boundaryError = (input: string[]): string | undefined => {
		if (trimWhitespace(input[0] ?? "") !== BEGIN) return `The first line of the patch must be '${BEGIN}'`;
		if (trimWhitespace(input.at(-1) ?? "") !== END) return `The last line of the patch must be '${END}'`;
		return undefined;
	};
	const error = boundaryError(lines);
	if (error) {
		if (
			lines.length >= 4 &&
			["<<EOF", "<<'EOF'", '<<"EOF"'].includes(lines[0] ?? "") &&
			lines.at(-1)?.endsWith("EOF")
		) {
			lines = lines.slice(1, -1);
			const innerError = boundaryError(lines);
			if (innerError) invalidPatch(innerError);
		} else {
			invalidPatch(error);
		}
	}

	const actions: ApplyPatchAction[] = [];
	let ended = false;
	let environmentId: string | undefined;
	const ensureUpdate = (line: number, next: string): void => {
		const action = actions.at(-1);
		if (action?.kind !== "update") return;
		if (action.hunks.length === 0) invalidHunk(action.line, `Update file hunk for path '${action.path}' is empty`);
		const last = action.hunks.at(-1);
		if (last && isEmpty(last)) {
			invalidHunk(line, next === END ? "Update hunk does not contain any lines" : unexpectedLine(next));
		}
	};
	for (let index = 1; index < lines.length; index += 1) {
		// parse_patch first uses str::lines, then the streaming parser strips
		// another CR before each LF in the rejoined text. Retain that quirk.
		const rawLine = lines[index] ?? "";
		const line = index < lines.length - 1 && rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		const number = index + 1;
		const trimmed = trimWhitespace(line);
		// StreamingPatchParser::finish accepts a fully trimmed final End Patch,
		// even in an update where other header lines only allow trailing padding.
		if (index === lines.length - 1 && trimmed === END) {
			ensureUpdate(number, trimmed);
			ended = true;
			continue;
		}
		if (ended) {
			if (trimmed !== "") invalidPatch(`The last line of the patch must be '${END}'`);
			continue;
		}
		const action = actions.at(-1);
		const marker = action?.kind === "update" ? trimEndWhitespace(line) : trimmed;
		if (!action && marker.startsWith(ENVIRONMENT)) {
			if (environmentId !== undefined) invalidPatch("apply_patch environment_id cannot be specified more than once");
			environmentId = trimWhitespace(marker.slice(ENVIRONMENT.length));
			if (environmentId === "") invalidPatch("apply_patch environment_id cannot be empty");
			continue;
		}
		if (marker === END) {
			ensureUpdate(number, marker);
			ended = true;
			continue;
		}
		const header = /^\*\*\* (Add|Update|Delete) File: ([\s\S]*)$/u.exec(marker);
		if (header) {
			ensureUpdate(number, marker);
			const path = header[2] ?? "";
			if (header[1] === "Add") actions.push({ kind: "add", path, content: "", line: number });
			else if (header[1] === "Delete") actions.push({ kind: "delete", path, line: number });
			else actions.push({ kind: "update", path, hunks: [], line: number });
			continue;
		}
		if (action?.kind === "add" && line.startsWith("+")) {
			action.content += `${line.slice(1)}\n`;
			continue;
		}
		if (action?.kind !== "update") {
			return invalidHunk(
				number,
				`'${trimmed}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`,
			);
		}
		let hunk = action.hunks.at(-1);
		const isContextMarker = marker === "@@" || marker.startsWith("@@ ");
		const expectedHeader = (): never =>
			invalidHunk(number, `Expected update hunk to start with a @@ context marker, got: '${line}'`);
		if (hunk?.endOfFile) {
			if (marker === "") continue;
			if (!isContextMarker) expectedHeader();
		}
		if (action.hunks.length === 0 && action.moveTo === undefined && marker.startsWith(MOVE)) {
			action.moveTo = marker.slice(MOVE.length);
			continue;
		}
		if (isContextMarker) {
			if (hunk && isEmpty(hunk)) invalidHunk(number, unexpectedLine(line));
			hunk = emptyHunk(number);
			if (marker !== "@@") hunk.anchors.push(marker.slice(3));
			action.hunks.push(hunk);
			continue;
		}
		if (marker === EOF) {
			if (hunk && isEmpty(hunk)) invalidHunk(number, "Update hunk does not contain any lines");
			if (hunk) hunk.endOfFile = true;
			continue;
		}
		if (line === "" || [" ", "+", "-"].includes(line[0] ?? "")) {
			if (!hunk) {
				hunk = emptyHunk(number);
				action.hunks.push(hunk);
			}
			const text = line.slice(1);
			if (line === "" || line.startsWith(" ")) {
				hunk.contextLineIndices.push([hunk.oldLines.length, hunk.newLines.length]);
				hunk.oldLines.push(text);
				hunk.newLines.push(text);
			} else if (line.startsWith("+")) hunk.newLines.push(text);
			else hunk.oldLines.push(text);
			continue;
		}
		if (hunk && !isEmpty(hunk)) expectedHeader();
		invalidHunk(number, unexpectedLine(line));
	}
	if (!ended) invalidPatch(`The last line of the patch must be '${END}'`);
	return actions;
}
