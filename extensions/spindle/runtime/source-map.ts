/**
 * Minimal source-map consumer for mapping guest runtime-error positions back
 * to the program the model wrote.
 *
 * The guest executes transpiled JavaScript under the file name
 * `pi-spindle-guest.js`, so a QuickJS stack trace reports positions in the
 * *emitted* code. TypeScript-only syntax (interfaces, type aliases,
 * annotations on their own lines) shifts line numbers between the two, so a
 * raw stack can point at the wrong line of the original program and send the
 * model hunting for a bug that is not there.
 *
 * The compiler emits the map against the wrapped source
 * (`async function __piSpindleMain() {\n<code>\n}`), whose first line is the
 * wrapper header. `headerLines` subtracts that line so mapped positions refer
 * to the user's code directly.
 */

/** File name the guest program is evaluated under. */
export const GUEST_PROGRAM_FILE = "pi-spindle-guest.js";
/** File name reported for positions mapped back to the model's program. */
export const MAPPED_PROGRAM_FILE = "program.ts";

export interface GuestSourcePosition {
	/** 1-based line in the user's program. */
	line: number;
	/** 1-based column in the user's program. */
	column: number;
}

export interface GuestSourceMap {
	originalPositionFor(line: number, column: number): GuestSourcePosition | undefined;
}

const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_VALUES = new Int32Array(128).fill(-1);
for (let index = 0; index < BASE64_CHARS.length; index++) {
	BASE64_VALUES[BASE64_CHARS.charCodeAt(index)] = index;
}

/** Decode one base64-VLQ integer starting at `cursor`; returns [value, next]. */
const decodeVlq = (text: string, cursor: number): [number, number] => {
	let result = 0;
	let shift = 0;
	let continuation = true;
	while (continuation) {
		const char = text.charCodeAt(cursor);
		const digit = char < 128 ? BASE64_VALUES[char]! : -1;
		if (digit < 0) throw new Error("Invalid source-map mappings");
		cursor += 1;
		continuation = (digit & 32) !== 0;
		result += (digit & 31) * 2 ** shift;
		shift += 5;
	}
	const negative = (result & 1) === 1;
	result = Math.floor(result / 2);
	return [negative ? -result : result, cursor];
};

interface RawSegment {
	generatedColumn: number;
	sourceIndex: number;
	sourceLine: number;
	sourceColumn: number;
}

/**
 * Parse a source map's JSON text. Returns undefined for absent, empty, or
 * malformed input: an unmappable error must degrade to its original text, not
 * crash the execution result.
 */
export const parseGuestSourceMap = (
	mapText: string | undefined,
	options: { headerLines?: number } = {},
): GuestSourceMap | undefined => {
	const headerLines = options.headerLines ?? 1;
	if (typeof mapText !== "string" || mapText.length === 0) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(mapText);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const mappings = (parsed as { mappings?: unknown }).mappings;
	const sources = (parsed as { sources?: unknown }).sources;
	if (typeof mappings !== "string" || !Array.isArray(sources)) return undefined;

	// Per generated line (0-based), segments sorted by generated column.
	const lines: RawSegment[][] = [];
	let sourceIndex = 0;
	let sourceLine = 0;
	let sourceColumn = 0;
	try {
		for (const lineText of mappings.split(";")) {
			const segments: RawSegment[] = [];
			let generatedColumn = 0;
			if (lineText.length > 0) {
				for (const segmentText of lineText.split(",")) {
					if (segmentText.length === 0) continue;
					let cursor = 0;
					const fields: number[] = [];
					while (cursor < segmentText.length) {
						const [value, next] = decodeVlq(segmentText, cursor);
						fields.push(value);
						cursor = next;
					}
					generatedColumn += fields[0] ?? 0;
					if (fields.length >= 4) {
						sourceIndex += fields[1]!;
						sourceLine += fields[2]!;
						sourceColumn += fields[3]!;
						segments.push({
							generatedColumn,
							sourceIndex,
							sourceLine,
							sourceColumn,
						});
					}
				}
			}
			lines.push(segments);
		}
	} catch {
		return undefined;
	}

	return {
		originalPositionFor(line, column) {
			const segments = lines[line - 1];
			if (segments === undefined || segments.length === 0) return undefined;
			let match: RawSegment | undefined;
			for (const segment of segments) {
				if (segment.generatedColumn <= column - 1) match = segment;
				else break;
			}
			if (match === undefined || match.sourceIndex >= sources.length) return undefined;
			const userLine = match.sourceLine + 1 - headerLines;
			if (userLine < 1) return undefined;
			return { line: userLine, column: match.sourceColumn + 1 };
		},
	};
};

const POSITION_PATTERN = new RegExp(`${GUEST_PROGRAM_FILE}:(\\d+):(\\d+)`, "g");

/**
 * Rewrite every `pi-spindle-guest.js:line:column` reference in an error text to
 * `program.ts:line:column` in the user's program. Unmapped positions are left
 * untouched, so partial maps never degrade the message.
 */
export const mapGuestErrorText = (text: string, map: GuestSourceMap | undefined): string => {
	if (map === undefined || !text.includes(GUEST_PROGRAM_FILE)) return text;
	return text.replaceAll(POSITION_PATTERN, (match, lineText: string, columnText: string) => {
		const position = map.originalPositionFor(Number(lineText), Number(columnText));
		if (position === undefined) return match;
		return `${MAPPED_PROGRAM_FILE}:${position.line}:${position.column}`;
	});
};
