/**
 * PORTED from upstream `src/fabric-exec-arguments.ts`.
 *
 * Pi validates custom-tool arguments before `tool_call` and `execute`, so every
 * compatibility coercion for the model-facing boundary lives here and is
 * installed through the official `prepareArguments` hook.
 */

import { normalizeRunDisplay } from "./run-display.ts";
import { repairSpindleGuestCode } from "./runtime/guest-code-repair.ts";

const OPTIONAL_SPINDLE_EXEC_KEYS = ["strings", "resultFormat", "agentBudget", "timeoutMs", "display"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const looksLikeJsonObject = (text: string): boolean => text.startsWith("{") && text.endsWith("}");

const looksLikeJsonString = (text: string): boolean => text.startsWith('"') && text.endsWith('"');

const parseJsonObject = (text: string): Record<string, unknown> | undefined => {
	const trimmed = text.trim();
	if (!looksLikeJsonObject(trimmed) && !looksLikeJsonString(trimmed)) return undefined;
	try {
		let parsed: unknown = JSON.parse(trimmed);
		// One extra unwrap: models sometimes JSON-encode the object twice.
		if (typeof parsed === "string") {
			const inner = parsed.trim();
			if (!looksLikeJsonObject(inner)) return undefined;
			parsed = JSON.parse(inner);
		}
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
};

const asStringRecord = (record: Record<string, unknown>): Record<string, string> | undefined => {
	if (Object.values(record).some((value) => typeof value !== "string")) return undefined;
	return record as Record<string, string>;
};

// Silent repair for the named-payload map. The declared shape is
// Record<string, string>, but models stringify nested maps (the highest-entropy
// escaped field in an otherwise flat tool), which strict schema validation
// rejects at the cost of a zero-work round trip.
const normalizeNamedStrings = (input: unknown): Record<string, string> | undefined => {
	if (isRecord(input)) return asStringRecord(input);
	if (typeof input !== "string") return undefined;
	const parsed = parseJsonObject(input);
	return parsed ? asStringRecord(parsed) : undefined;
};

export const resolveSpindleExecStrings = (params: { strings?: unknown }): Record<string, string> | undefined =>
	normalizeNamedStrings(params.strings);

/**
 * Coerce the model-facing `spindle_exec` arguments into the declared shape
 * before Pi validates them: join a `code` array, quote unquoted path heads,
 * parse a JSON-encoded `strings` map, drop nullish optionals, and normalize a
 * bare `display` string.
 */
export const prepareSpindleExecArguments = (input: unknown): unknown => {
	if (typeof input === "string") return { code: repairSpindleGuestCode(input) };
	if (!isRecord(input)) return input;

	let prepared = input;
	const writable = (): Record<string, unknown> => {
		if (prepared === input) prepared = { ...input };
		return prepared;
	};

	if (Array.isArray(prepared.code) && prepared.code.every((line) => typeof line === "string")) {
		writable().code = prepared.code.join("\n");
	}
	if (typeof prepared.code === "string") {
		const repaired = repairSpindleGuestCode(prepared.code);
		if (repaired !== prepared.code) writable().code = repaired;
	}

	for (const key of OPTIONAL_SPINDLE_EXEC_KEYS) {
		if (!Object.hasOwn(prepared, key)) continue;
		if (prepared[key] === null || prepared[key] === undefined) delete writable()[key];
	}

	const display = prepared.display;
	if (typeof display === "string" || isRecord(display)) {
		const normalized = normalizeRunDisplay(display);
		if (normalized) writable().display = normalized;
		else delete writable().display;
	}

	if (Object.hasOwn(prepared, "strings")) {
		const normalized = normalizeNamedStrings(prepared.strings);
		if (normalized && prepared.strings !== normalized) writable().strings = normalized;
	}

	return prepared;
};
