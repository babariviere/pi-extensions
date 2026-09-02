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
 * The `mcp` surface is generated too, but only from the on-disk MCP tool cache
 * (mcp/tool-cache.ts): one typed `call` overload per cached (server, tool)
 * pair, followed by the loose overloads so a computed server or an uncached
 * tool still compiles. Nothing here connects a server, so the type gate cannot
 * trigger an OAuth prompt.
 */

import type {
	SpindleDynamicGuestDeclarations,
	SpindleGuestTypeSources,
	SpindleMcpServerTypeSource,
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
		members.push(
			isRecord(additional) ? `[key: string]: ${schemaType(additional, depth + 1)}` : "[key: string]: unknown",
		);
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

/** Cap across every server, so a chatty catalog cannot blow up the declarations. */
const MAX_MCP_TOOLS = 512;

/**
 * The generated `mcp` surface is a tool MAP indexed by server and tool name,
 * not a list of overloads.
 *
 * Overloads were the first attempt and do not work: TypeScript picks the first
 * signature that matches, so the permissive
 * `call(server: string, tool: string, args?: Record<string, unknown>)` fallback
 * that has to stay for uncached tools silently absorbs every mistake on a tool
 * whose schema is known.
 *
 * What ships instead is one signature indexing a generated map,
 * `args?: SpindleMcpToolMap[S][T]`, with index signatures at both levels so an
 * uncached tool or a computed server name still types as
 * `Record<string, unknown>`.
 *
 * What that catches, exactly: an unknown or misspelled property on a cached
 * tool, which is the common failure. What it does not catch: a wrongly typed
 * property, or a missing required one. `SpindleMcpToolMap[S][T]` is a generic
 * indexed access and therefore deferred, and TypeScript runs excess-property
 * checking against a deferred target but skips assignability. Both slip through
 * to dispatch, where the server's own schema validation refuses them with a
 * message naming the argument. Strengthening this further needs a negated type
 * (`tool: string except the cached names`), which TypeScript does not have.
 */
const renderMcpToolEntry = (source: SpindleNamedActionTypeSource, budget: RenderBudget): string | undefined => {
	const schemaJson = JSON.stringify(source.inputSchema);
	const rendered =
		schemaJson && schemaJson.length <= MAX_SCHEMA_SOURCE_CHARS ? schemaType(source.inputSchema, 0) : undefined;
	if (!rendered || rendered.length > MAX_MEMBER_TYPE_CHARS) return undefined;
	const text = `    ${propertyKey(source.name)}: ${rendered};`;
	return spend(budget, text) ? text : undefined;
};

const renderMcpDeclaration = (servers: SpindleMcpServerTypeSource[]): string => {
	const budget: RenderBudget = { chars: MAX_SECTION_CHARS };
	const blocks: string[] = [];
	let dropped = 0;
	let rendered = 0;
	for (const entry of [...servers].sort((left, right) => left.server.localeCompare(right.server))) {
		const seen = new Set<string>();
		const lines: string[] = [];
		for (const tool of [...entry.tools].sort((left, right) => left.name.localeCompare(right.name))) {
			if (seen.has(tool.name)) continue;
			seen.add(tool.name);
			if (rendered >= MAX_MCP_TOOLS) {
				dropped += 1;
				continue;
			}
			const line = renderMcpToolEntry(tool, budget);
			if (!line) {
				dropped += 1;
				continue;
			}
			lines.push(line);
			rendered += 1;
		}
		// The per-server index signature is what lets an uncached tool on a cached
		// server stay callable instead of becoming a type error.
		if (lines.length > 0) {
			blocks.push(
				`  ${propertyKey(entry.server)}: {\n${lines.join("\n")}\n    [tool: string]: Record<string, unknown>;\n  };`,
			);
		}
	}
	if (blocks.length === 0) return "";
	const serverNames = [...new Set(servers.map((entry) => entry.server))].sort();
	const note =
		dropped > 0
			? `// Omitted ${dropped} tool(s) from this map; those calls type as\n// Record<string, unknown> and are still validated by the server at dispatch.\n`
			: "";
	return (
		"// Generated from the on-disk MCP tool cache: a cached (server, tool) pair\n" +
		"// carries its real input schema, so a misspelled or unknown argument fails\n" +
		"// the type gate before the sandbox runs. An uncached tool, or a server name\n" +
		"// computed at runtime, types as Record<string, unknown>. Argument types and\n" +
		"// required arguments are enforced by the server at dispatch. Generating this\n" +
		"// never connects to a server, so it can never trigger an auth prompt.\n" +
		note +
		`// Cached servers: ${serverNames.join(", ")}\n` +
		`interface SpindleMcpToolMap {\n${blocks.join("\n")}\n  [server: string]: Record<string, Record<string, unknown>>;\n}\n` +
		"type SpindleMcpApiDynamic = {\n" +
		"  call<S extends string, T extends string>(server: S, tool: T, args?: SpindleMcpToolMap[S][T]): Promise<SpindleMcpResult>;\n" +
		"  call(args: { server?: string; tool: string; args?: Record<string, unknown> }): Promise<SpindleMcpResult | unknown>;\n" +
		"  list(server: string): Promise<unknown>;\n" +
		"  list(args?: { server?: string }): Promise<unknown>;\n" +
		"  connect(server: string): Promise<unknown>;\n" +
		"  search(args: string | { query: string; server?: string; regex?: boolean; includeSchemas?: boolean }): Promise<unknown>;\n" +
		"  describe(args: string | { tool: string; server?: string }): Promise<unknown>;\n" +
		"};\n" +
		"declare const mcp: SpindleMcpApiDynamic;\n"
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
	if (sources.mcpServers && sources.mcpServers.length > 0) {
		const mcp = renderMcpDeclaration(sources.mcpServers);
		if (mcp) dynamic.mcp = mcp;
	}
	return dynamic;
};
