/**
 * PORTED (and adapted) from upstream `src/type-error-guidance.ts`.
 *
 * Type errors are the cheapest place to teach a recovery: the program never
 * ran, so a one-line hint next to the diagnostics converts a wasted round trip
 * into a corrected one.
 */

import { CORE_TOOL_NAMES, CORE_TOOL_PROPERTIES } from "./runtime/core-tool-properties.ts";
import type { SpindleTypeError } from "./runtime/type-checker.ts";

const SYNTAX_ERROR_PATTERN = /expected|unterminated|unexpected|invalid character/i;
const PAYLOAD_CALL_PATTERN = /\bpi\.(?:edit|write)\s*\(/;
const UNQUOTED_PATH_HEAD = /\bpi\.(?:read|ls|write|edit)\(\s*(?:https?:\/\/|\/(?![/*])|\.\/|\.\.\/|~\/|[A-Za-z]:[\\/])/;
const PROMISE_ALL_PATTERN = /\bPromise\.all\s*\(/;
const TUPLE_ARITY_PATTERN = /Tuple type .* of length '[0-9]+' has no element at index '[0-9]+'/;
const MISSING_NAME_PATTERN = /^Cannot find name '([^']+)'/;
const UNKNOWN_PROPERTY_PATTERN = /'([^']+)' does not exist in type '([^']+)'/;
const PI_CALL_PATTERN = /\bpi\.(\w+)\s*\(/g;

// spindle_exec envelope arguments that are commonly misplaced inside `code`.
const SPINDLE_EXEC_ARGUMENT_NOTES: Readonly<Record<string, string>> = {
	payloads:
		"named `payloads` belong in the outer `spindle_exec` arguments, then become available inside `code` as `\u03c0.key`.",
	strings:
		"`strings` is the legacy alias for outer `payloads`; named values belong in the outer `spindle_exec` arguments, then become available inside `code` as `\u03c0.key`.",
	agentBudget: "`agentBudget` belongs to the outer `spindle_exec` call, not inside `code`.",
	timeoutMs: "`timeoutMs` belongs to the outer `spindle_exec` call, not inside `code`.",
	display: "the `display` objective belongs to the outer `spindle_exec` call, not inside `code`.",
	resultFormat: "`resultFormat` belongs to the outer `spindle_exec` call, not inside `code`.",
};

const PROPERTY_NOTES: Readonly<Record<string, string>> = {
	settle: "`settle:true` settles nonzero `pi.bash` exits into an `ok:false` envelope instead of rejecting; other `pi.*` calls reject failures normally.",
	timeout: "`timeout` is measured in seconds; `timeoutMs` is converted from milliseconds.",
};

const isCoreToolName = (name: string): boolean => CORE_TOOL_NAMES.includes(name);

// Spindle declares core tool arguments inline, so the checked type text rarely
// names the tool; the option bags it does name (SpindleBashOptions) still do.
const toolFromTypeText = (typeText: string): string | undefined => {
	for (const match of typeText.matchAll(/\bSpindle([A-Z]\w*?)Options\b/g)) {
		const candidate = match[1]?.toLowerCase();
		if (candidate !== undefined && isCoreToolName(candidate)) return candidate;
	}
	return undefined;
};

// Fallback for anonymous argument types: find the `pi.<tool>(` call enclosing
// the error position. Type-checker lines are 1-based and preceded by the guest
// wrapper, so try both offsets.
const enclosingCoreTool = (code: string, error: SpindleTypeError): string | undefined => {
	const lines = code.split("\n");
	for (const lineIndex of [error.line - 2, error.line - 1]) {
		if (lineIndex < 0 || lineIndex >= lines.length) continue;
		const offset =
			lines.slice(0, lineIndex).join("\n").length + (lineIndex > 0 ? 1 : 0) + Math.max(0, error.column - 1);
		PI_CALL_PATTERN.lastIndex = 0;
		let match: RegExpExecArray | null;
		let tool: string | undefined;
		while ((match = PI_CALL_PATTERN.exec(code)) !== null && match.index < offset) {
			const called = match[1];
			if (called !== undefined && isCoreToolName(called)) tool = called;
		}
		if (tool !== undefined) return tool;
	}
	return undefined;
};

const unknownPropertyHint = (property: string, tool: string | undefined): string | undefined => {
	if (tool === undefined) return undefined;
	const envelopeNote = SPINDLE_EXEC_ARGUMENT_NOTES[property];
	if (envelopeNote !== undefined) {
		return `Recovery hint: \`${property}\` is a \`spindle_exec\` argument, not a \`pi.${tool}\` property. ${envelopeNote}`;
	}
	const ownerTools = CORE_TOOL_PROPERTIES.get(property);
	if (ownerTools === undefined || ownerTools.includes(tool)) return undefined;
	const owners = ownerTools.map((owner) => `\`pi.${owner}\``).join(", ");
	const note = PROPERTY_NOTES[property];
	return `Recovery hint: \`${property}\` is not a \`pi.${tool}\` property \u2014 it belongs to ${owners}.${note ? ` ${note}` : ""}`;
};

const hasLiteralPayloadInterpolation = (code: string, errors: SpindleTypeError[]): boolean => {
	if (!PAYLOAD_CALL_PATTERN.test(code)) return false;
	return errors.some((error) => {
		const name = MISSING_NAME_PATTERN.exec(error.message)?.[1];
		return name !== undefined && code.includes(`\${${name}}`);
	});
};

/** One actionable recovery line for the first diagnosis Spindle recognizes. */
export const typeErrorRecoveryHint = (code: string, errors: SpindleTypeError[]): string | undefined => {
	for (const error of errors) {
		const matched = UNKNOWN_PROPERTY_PATTERN.exec(error.message);
		const property = matched?.[1];
		const typeText = matched?.[2];
		if (property !== undefined && typeText !== undefined) {
			const tool = toolFromTypeText(typeText) ?? enclosingCoreTool(code, error);
			const hint = unknownPropertyHint(property, tool);
			if (hint) return hint;
		}
	}
	if (PROMISE_ALL_PATTERN.test(code) && errors.some((error) => TUPLE_ARITY_PATTERN.test(error.message))) {
		return "Recovery hint: match `Promise.all` destructuring one binding per promise; remove the extra binding or add the missing call.";
	}
	if (hasLiteralPayloadInterpolation(code, errors)) {
		return "Recovery hint: a `${...}` expression in an edit/write payload is being evaluated by the Spindle TypeScript program. Declare it if intentional; for literal file content, move the payload to top-level `strings` and reference `\u03c0.key`.";
	}
	if (
		UNQUOTED_PATH_HEAD.test(code) &&
		errors.some(
			(error) =>
				SYNTAX_ERROR_PATTERN.test(error.message) ||
				error.message.includes("Cannot find name") ||
				error.message.includes("Expected 1-2 arguments"),
		)
	) {
		return "Recovery hint: quote filesystem paths and URLs as strings, e.g. `pi.read('/x')` or `pi.read({ path: '/x' })`. Unquoted paths are parsed as regex, division, or extra arguments.";
	}
	if (!PAYLOAD_CALL_PATTERN.test(code)) return undefined;
	if (!errors.some((error) => SYNTAX_ERROR_PATTERN.test(error.message))) return undefined;
	return "Recovery hint: if embedded edit/write payload text caused the syntax error, pass it through top-level `strings` and reference `\u03c0.key` instead of escaping it inside `code`.";
};
