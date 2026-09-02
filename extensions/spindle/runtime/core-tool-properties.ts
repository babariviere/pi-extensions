/**
 * PORTED (and adapted) from upstream `src/runtime/core-tool-properties.ts`.
 *
 * Spindle declares the core tools as inline signatures on `PiToolsApi` rather
 * than named `Pi<Tool>Argument` aliases, so the property table is derived by
 * scanning each member's argument list plus any option-bag type it references.
 */

import { GUEST_TYPE_DECLARATIONS } from "./guest-types.ts";

const PI_TOOLS_API_HEADER = "interface PiToolsApi {";

// Type aliases are matched with a bracket-depth scan (not `[^;]`) because union
// members like `{ edits: Array<{ oldText: string }> }` contain interior
// semicolons.
const extractTypeDeclarations = (declarations: string): Map<string, string> => {
	const parsed = new Map<string, string>();
	for (const match of declarations.matchAll(/\btype\s+(\w+)\s*=/g)) {
		const name = match[1];
		if (name === undefined) continue;
		const rhsStart = match.index + match[0].length;
		let depth = 0;
		let end = rhsStart;
		while (end < declarations.length) {
			const character = declarations[end];
			if (character === "(" || character === "{" || character === "[") depth += 1;
			else if (character === ")" || character === "}" || character === "]") depth -= 1;
			else if (character === ";" && depth === 0) break;
			end += 1;
		}
		parsed.set(name, declarations.slice(rhsStart, end));
	}
	return parsed;
};

/** The `(` … `)` argument list of one interface member signature. */
const argumentList = (signature: string): string | undefined => {
	const open = signature.indexOf("(");
	if (open === -1) return undefined;
	let depth = 0;
	for (let index = open; index < signature.length; index++) {
		const character = signature[index];
		if (character === "(" || character === "{" || character === "[" || character === "<") depth += 1;
		else if (character === ")" || character === "}" || character === "]" || character === ">") {
			depth -= 1;
			if (depth === 0) return signature.slice(open + 1, index);
		}
	}
	return undefined;
};

const objectLiteralKeys = (text: string): string[] =>
	[...text.matchAll(/([A-Za-z_]\w*)\s*\??:/g)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));

const referencedOptionTypes = (text: string): string[] =>
	[...text.matchAll(/\b(Spindle[A-Z]\w*)/g)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));

/** Member name -> every declared signature of that `pi.*` tool. */
const piToolSignatures = (declarations: string): Map<string, string[]> => {
	const signatures = new Map<string, string[]>();
	const start = declarations.indexOf(PI_TOOLS_API_HEADER);
	if (start === -1) return signatures;
	const lines = declarations.slice(start + PI_TOOLS_API_HEADER.length).split("\n");
	for (const line of lines) {
		if (line === "}") break;
		const member = /^\s{2}([A-Za-z][A-Za-z0-9_]*)\(/.exec(line);
		if (!member?.[1]) continue;
		const existing = signatures.get(member[1]) ?? [];
		existing.push(line);
		signatures.set(member[1], existing);
	}
	return signatures;
};

const collect = (
	declarations: string,
): { names: string[]; properties: Map<string, string[]> } => {
	const typeDeclarations = extractTypeDeclarations(declarations);
	const signatures = piToolSignatures(declarations);
	const owners = new Map<string, Set<string>>();
	for (const [tool, memberLines] of signatures) {
		const visit = (text: string, seen: Set<string>): void => {
			for (const property of objectLiteralKeys(text)) {
				const toolSet = owners.get(property) ?? new Set<string>();
				toolSet.add(tool);
				owners.set(property, toolSet);
			}
			for (const reference of referencedOptionTypes(text)) {
				if (seen.has(reference)) continue;
				seen.add(reference);
				const rhs = typeDeclarations.get(reference);
				if (rhs !== undefined) visit(rhs, seen);
			}
		};
		for (const line of memberLines) {
			const args = argumentList(line);
			if (args !== undefined) visit(args, new Set());
		}
	}
	return {
		names: [...signatures.keys()],
		properties: new Map([...owners].map(([property, toolSet]) => [property, [...toolSet]])),
	};
};

const collected = collect(GUEST_TYPE_DECLARATIONS);

/** Every `pi.<tool>` the guest declarations expose. */
export const CORE_TOOL_NAMES: readonly string[] = collected.names;

/** Property name -> every core tool whose argument or options bag accepts it. */
export const CORE_TOOL_PROPERTIES: ReadonlyMap<string, readonly string[]> = collected.properties;
