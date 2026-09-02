/**
 * PORTED (and trimmed) from upstream `src/runtime/dynamic-guest-types.ts`.
 *
 * Renders guest .d.ts fragments for the dynamic call surface (`extensions.<tool>`)
 * from live provider descriptors, closing the type-check gap that surface had as
 * a `Record<string, callable>`: argument-shape mistakes surfaced only at dispatch
 * time. The generated surface stays advisory — the registry still validates every
 * call against the action's own inputSchema before invoke, so drift between
 * these declarations and a live tool fails at the usual validate stage.
 *
 * `mcp` has no generated surface: the bridge provider never pre-fetches a
 * server's tool list, so there is no side-effect-free descriptor source.
 */

import type {
	SpindleDynamicGuestDeclarations,
	SpindleGuestTypeSources,
	SpindleNamedActionTypeSource,
} from "../protocol.ts";

const MAX_DEPTH = 6;
const MAX_UNION_MEMBERS = 12;
const MAX_SCHEMA_SOURCE_CHARS = 4_096;
const MAX_MEMBER_TYPE_CHARS = 2_500;
const MAX_SECTION_CHARS = 60_000;
const MAX_EXTENSION_TOOLS = 256;

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const propertyKey = (name: string): string => (IDENTIFIER.test(name) ? name : JSON.stringify(name));

const literalType = (value: unknown): string => {
	if (value === null) return "null";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
	if (typeof value === "boolean") return value ? "true" : "false";
	return "unknown";
};

const unionType = (parts: string[]): string => {
	const unique = [...new Set(parts)];
	if (unique.length === 0) return "unknown";
	return unique.length === 1 ? unique[0]! : unique.join(" | ");
};

const typeList = (value: unknown): string[] => {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
	return [];
};

const objectType = (schema: Record<string, unknown>, depth: number): string => {
	const properties = isRecord(schema.properties) ? schema.properties : {};
	const required = new Set(
		Array.isArray(schema.required)
			? schema.required.filter((entry): entry is string => typeof entry === "string")
			: [],
	);
	const members: string[] = [];
	for (const key of Object.keys(properties).sort()) {
		members.push(`${propertyKey(key)}${required.has(key) ? "" : "?"}: ${schemaType(properties[key], depth + 1)}`);
	}
	const additional = schema.additionalProperties;
	if (additional !== false) {
		members.push(isRecord(additional) ? `[key: string]: ${schemaType(additional, depth + 1)}` : "[key: string]: unknown");
	}
	return `{ ${members.join("; ")} }`;
};

const schemaType = (schema: unknown, depth: number): string => {
	if (depth > MAX_DEPTH) return "unknown";
	if (schema === true || schema === undefined) return "unknown";
	if (schema === false) return "never";
	if (!isRecord(schema)) return "unknown";
	if ("const" in schema) return literalType(schema.const);
	if (Array.isArray(schema.enum) && schema.enum.length > 0) {
		return unionType(schema.enum.slice(0, MAX_UNION_MEMBERS).map(literalType));
	}
	const alternates = Array.isArray(schema.anyOf)
		? schema.anyOf
		: Array.isArray(schema.oneOf)
			? schema.oneOf
			: undefined;
	if (alternates) {
		if (alternates.length === 0) return "unknown";
		return unionType(alternates.slice(0, MAX_UNION_MEMBERS).map((entry) => schemaType(entry, depth + 1)));
	}
	if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
		return schema.allOf
			.slice(0, MAX_UNION_MEMBERS)
			.map((entry) => {
				const rendered = schemaType(entry, depth + 1);
				return rendered.includes(" | ") ? `(${rendered})` : rendered;
			})
			.join(" & ");
	}
	const types = typeList(schema.type);
	if (types.length > 1) {
		return unionType(types.map((type) => schemaType({ ...schema, type }, depth + 1)));
	}
	const type = types[0];
	if (type === "object" || (!type && isRecord(schema.properties))) return objectType(schema, depth);
	if (type === "string") return "string";
	if (type === "number" || type === "integer") return "number";
	if (type === "boolean") return "boolean";
	if (type === "null") return "null";
	if (type === "array") {
		const items = schema.items;
		if (Array.isArray(items)) {
			return `[${items
				.slice(0, MAX_UNION_MEMBERS)
				.map((entry) => schemaType(entry, depth + 1))
				.join(", ")}]`;
		}
		return isRecord(items) || items === true ? `Array<${schemaType(items, depth + 1)}>` : "unknown[]";
	}
	return "unknown";
};

interface RenderBudget {
	chars: number;
}

const spend = (budget: RenderBudget, text: string): boolean => {
	if (budget.chars < text.length) return false;
	budget.chars -= text.length;
	return true;
};

const hasRequiredArgs = (source: SpindleNamedActionTypeSource): boolean =>
	Array.isArray(source.inputSchema.required) &&
	source.inputSchema.required.length > 0 &&
	isRecord(source.inputSchema.properties);

const renderMember = (source: SpindleNamedActionTypeSource, resultType: string): string => {
	const loose = `${propertyKey(source.name)}(args?: Record<string, unknown>): ${resultType};`;
	const schemaJson = JSON.stringify(source.inputSchema);
	if (!schemaJson || schemaJson.length > MAX_SCHEMA_SOURCE_CHARS) return loose;
	const rendered = schemaType(source.inputSchema, 0);
	if (rendered.length > MAX_MEMBER_TYPE_CHARS) return loose;
	return `${propertyKey(source.name)}(args${hasRequiredArgs(source) ? "" : "?"}: ${rendered}): ${resultType};`;
};

const renderMemberBlock = (
	sources: SpindleNamedActionTypeSource[],
	resultType: string,
	limit: number,
	budget: RenderBudget,
): { lines: string[]; dropped: number } => {
	const byName = new Map<string, SpindleNamedActionTypeSource>();
	let dropped = Math.max(0, sources.length - limit);
	for (const source of sources.slice(0, limit)) {
		if (byName.has(source.name)) dropped += 1;
		else byName.set(source.name, source);
	}
	const lines: string[] = [];
	for (const name of [...byName.keys()].sort((left, right) => left.localeCompare(right))) {
		const text = `  ${renderMember(byName.get(name)!, resultType)}`;
		if (!spend(budget, text)) {
			dropped += 1;
			continue;
		}
		lines.push(text);
	}
	return { lines, dropped };
};

const renderExtensionsDeclaration = (sources: SpindleNamedActionTypeSource[]): string => {
	const budget: RenderBudget = { chars: MAX_SECTION_CHARS };
	const memberBlock = renderMemberBlock(sources, "Promise<SpindleCapturedToolResult>", MAX_EXTENSION_TOOLS, budget);
	if (memberBlock.lines.length === 0) return "";
	const note =
		memberBlock.dropped > 0
			? `// Omitted ${memberBlock.dropped} tool(s) from this surface; those calls\n// compile as the loose fallback would and still validate at dispatch.\n`
			: "";
	return (
		"// Generated from the captured extension tool catalog for this execution:\n" +
		"// known tools carry their schemas so argument-shape mistakes fail the type\n" +
		"// gate before the sandbox runs. Anything absent compiles as the loose\n" +
		"// declaration would and is validated by the registry at dispatch.\n" +
		note +
		`interface SpindleExtensionsApiDynamic {\n${memberBlock.lines.join("\n")}\n}\n` +
		"declare const extensions: SpindleExtensionsApiDynamic;\n"
	);
};

/**
 * Render replacement `declare const` blocks for guestTypeDeclarations(). Missing
 * or empty sections return nothing so the loose static lines survive.
 */
export const buildDynamicGuestDeclarations = (sources: SpindleGuestTypeSources): SpindleDynamicGuestDeclarations => {
	const dynamic: SpindleDynamicGuestDeclarations = {};
	if (sources.extensionTools && sources.extensionTools.length > 0) {
		const extensions = renderExtensionsDeclaration(sources.extensionTools);
		if (extensions) dynamic.extensions = extensions;
	}
	return dynamic;
};
