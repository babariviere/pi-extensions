/**
 * PORTED (and trimmed) from upstream `src/runtime/dynamic-guest-types.ts`.
 *
 * Renders guest .d.ts fragments for the dynamic call surface (explicit provider tools)
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
	CodeModeDynamicGuestDeclarations,
	CodeModeGuestTypeSources,
	CodeModeMcpServerTypeSource,
	CodeModeNamedActionTypeSource,
	CodeModeProviderTypeSource,
} from "../protocol.ts";

const MAX_DEPTH = 6;
const MAX_UNION_MEMBERS = 12;
const MAX_SCHEMA_SOURCE_CHARS = 4_096;
const MAX_MEMBER_TYPE_CHARS = 2_500;
const MAX_SECTION_CHARS = 60_000;
const MAX_MCP_TOOLS = 512;
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

const objectType = (schema: Record<string, unknown>, depth: number, exactObjects: boolean): string => {
	const properties = isRecord(schema.properties) ? schema.properties : {};
	const required = new Set(
		Array.isArray(schema.required)
			? schema.required.filter((entry): entry is string => typeof entry === "string")
			: [],
	);
	const members: string[] = [];
	for (const key of Object.keys(properties).sort()) {
		members.push(
			`${propertyKey(key)}${required.has(key) ? "" : "?"}: ${schemaType(properties[key], depth + 1, exactObjects)}`,
		);
	}
	const additional = schema.additionalProperties;
	if (additional !== false && !(exactObjects && additional === undefined)) {
		members.push(
			isRecord(additional)
				? `[key: string]: ${schemaType(additional, depth + 1, exactObjects)}`
				: "[key: string]: unknown",
		);
	}
	if (members.length === 0) return "Record<string, never>";
	return `{ ${members.join("; ")} }`;
};

const schemaType = (schema: unknown, depth: number, exactObjects = false): string => {
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
		return unionType(
			alternates.slice(0, MAX_UNION_MEMBERS).map((entry) => schemaType(entry, depth + 1, exactObjects)),
		);
	}
	if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
		return schema.allOf
			.slice(0, MAX_UNION_MEMBERS)
			.map((entry) => {
				const rendered = schemaType(entry, depth + 1, exactObjects);
				return rendered.includes(" | ") ? `(${rendered})` : rendered;
			})
			.join(" & ");
	}
	const types = typeList(schema.type);
	if (types.length > 1) {
		return unionType(types.map((type) => schemaType({ ...schema, type }, depth + 1, exactObjects)));
	}
	const type = types[0];
	if (type === "object" || (!type && isRecord(schema.properties))) return objectType(schema, depth, exactObjects);
	if (type === "string") return "string";
	if (type === "number" || type === "integer") return "number";
	if (type === "boolean") return "boolean";
	if (type === "null") return "null";
	if (type === "array") {
		const items = schema.items;
		if (Array.isArray(items)) {
			return `[${items
				.slice(0, MAX_UNION_MEMBERS)
				.map((entry) => schemaType(entry, depth + 1, exactObjects))
				.join(", ")}]`;
		}
		return isRecord(items) || items === true ? `Array<${schemaType(items, depth + 1, exactObjects)}>` : "unknown[]";
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

const hasRequiredArgs = (source: CodeModeNamedActionTypeSource): boolean =>
	Array.isArray(source.inputSchema.required) &&
	source.inputSchema.required.length > 0 &&
	isRecord(source.inputSchema.properties);

const renderMember = (
	source: CodeModeNamedActionTypeSource,
	resultType: string,
	exactObjects = false,
	exactArgsType?: string,
): string => {
	const loose = `${propertyKey(source.name)}(args?: Record<string, unknown>): ${resultType};`;
	const schemaJson = JSON.stringify(source.inputSchema);
	if (!schemaJson || schemaJson.length > MAX_SCHEMA_SOURCE_CHARS) return loose;
	const rendered = schemaType(source.inputSchema, 0, exactObjects);
	if (rendered.length > MAX_MEMBER_TYPE_CHARS) return loose;
	if (exactArgsType) {
		const checked = `<Args>(args: Args, ...invalid: ${exactArgsType}<Args, ${rendered}> extends true ? [] : [never]): ${resultType};`;
		if (hasRequiredArgs(source)) return `${propertyKey(source.name)}${checked}`;
		return `${propertyKey(source.name)}(): ${resultType};\n  ${propertyKey(source.name)}${checked}`;
	}
	return `${propertyKey(source.name)}(args${hasRequiredArgs(source) ? "" : "?"}: ${rendered}): ${resultType};`;
};

const renderMemberBlock = (
	sources: CodeModeNamedActionTypeSource[],
	resultType: string | ((source: CodeModeNamedActionTypeSource) => string),
	limit: number,
	budget: RenderBudget,
	exactObjects = false,
	exactArgsType?: string,
): { lines: string[]; dropped: number } => {
	const byName = new Map<string, CodeModeNamedActionTypeSource>();
	let dropped = Math.max(0, sources.length - limit);
	for (const source of sources.slice(0, limit)) {
		if (byName.has(source.name)) dropped += 1;
		else byName.set(source.name, source);
	}
	const lines: string[] = [];
	for (const name of [...byName.keys()].sort((left, right) => left.localeCompare(right))) {
		const source = byName.get(name)!;
		const resolvedResultType = typeof resultType === "function" ? resultType(source) : resultType;
		const text = `  ${renderMember(source, resolvedResultType, exactObjects, exactArgsType)}`;
		if (!spend(budget, text)) {
			dropped += 1;
			continue;
		}
		lines.push(text);
	}
	return { lines, dropped };
};

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
 * `args?: CodeModeMcpToolMap[S][T]`, with index signatures at both levels so an
 * uncached tool or a computed server name still types as
 * `Record<string, unknown>`.
 *
 * What that catches, exactly: an unknown or misspelled property on a cached
 * tool, which is the common failure. What it does not catch: a wrongly typed
 * property, or a missing required one. `CodeModeMcpToolMap[S][T]` is a generic
 * indexed access and therefore deferred, and TypeScript runs excess-property
 * checking against a deferred target but skips assignability. Both slip through
 * to dispatch, where the server's own schema validation refuses them with a
 * message naming the argument. Strengthening this further needs a negated type
 * (`tool: string except the cached names`), which TypeScript does not have.
 */
const renderMcpToolEntry = (source: CodeModeNamedActionTypeSource, budget: RenderBudget): string | undefined => {
	const schemaJson = JSON.stringify(source.inputSchema);
	const rendered =
		schemaJson && schemaJson.length <= MAX_SCHEMA_SOURCE_CHARS ? schemaType(source.inputSchema, 0) : undefined;
	if (!rendered || rendered.length > MAX_MEMBER_TYPE_CHARS) return undefined;
	const text = `    ${propertyKey(source.name)}: ${rendered};`;
	return spend(budget, text) ? text : undefined;
};

const renderMcpDeclaration = (servers: CodeModeMcpServerTypeSource[]): string => {
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
		`interface CodeModeMcpToolMap {\n${blocks.join("\n")}\n  [server: string]: Record<string, Record<string, unknown>>;\n}\n` +
		"type CodeModeMcpApiDynamic = {\n" +
		"  call<S extends string, T extends string>(server: S, tool: T, args?: CodeModeMcpToolMap[S][T]): Promise<CodeModeMcpResult>;\n" +
		"  call(args: { server?: string; tool: string; args?: Record<string, unknown> }): Promise<CodeModeMcpResult | unknown>;\n" +
		"  list(server: string): Promise<unknown>;\n" +
		"  list(args?: { server?: string }): Promise<unknown>;\n" +
		"  connect(server: string): Promise<unknown>;\n" +
		"  search(args: string | { query: string; server?: string; regex?: boolean; includeSchemas?: boolean }): Promise<unknown>;\n" +
		"  describe(args: string | { tool: string; server?: string }): Promise<unknown>;\n" +
		"};\n" +
		"declare const mcp: CodeModeMcpApiDynamic;\n"
	);
};

const renderedOutputType = (source: CodeModeNamedActionTypeSource): string => {
	if (!source.outputSchema) return "unknown";
	const schemaJson = JSON.stringify(source.outputSchema);
	if (!schemaJson || schemaJson.length > MAX_SCHEMA_SOURCE_CHARS) return "unknown";
	const rendered = schemaType(source.outputSchema, 0, true);
	return rendered.length <= MAX_MEMBER_TYPE_CHARS ? rendered : "unknown";
};

const providerInterfaceName = (provider: string): string =>
	`CodeModeProviderApi_${[...provider]
		.map((character) =>
			/^[A-Za-z0-9]$/.test(character) ? character : `_x${character.codePointAt(0)!.toString(16)}_`,
		)
		.join("")}`;

const renderProviderDeclaration = (source: CodeModeProviderTypeSource): string => {
	const budget: RenderBudget = { chars: MAX_SECTION_CHARS };
	const interfaceName = providerInterfaceName(source.name);
	const exactArgsType = `${interfaceName}ExactArgs`;
	const members = renderMemberBlock(
		source.actions,
		(action) => `Promise<${renderedOutputType(action)}>`,
		MAX_EXTENSION_TOOLS,
		budget,
		true,
		exactArgsType,
	);
	// A partial interface would reject real registered methods. Keep the loose
	// declaration when the complete listed surface cannot be represented.
	if (members.dropped > 0) return "";
	return (
		`// Generated from the live ${source.name} provider action descriptors.\n` +
		`type ${exactArgsType}<Actual, Expected> = Actual extends Expected\n` +
		"  ? Expected extends readonly (infer ExpectedItem)[]\n" +
		`    ? Actual extends readonly (infer ActualItem)[] ? ${exactArgsType}<ActualItem, ExpectedItem> : false\n` +
		"    : Expected extends object\n" +
		"      ? Exclude<keyof Actual, keyof Expected> extends never\n" +
		`        ? false extends { [Key in keyof Actual]: Key extends keyof Expected ? ${exactArgsType}<Actual[Key], Expected[Key]> : false }[keyof Actual] ? false : true\n` +
		"        : false\n" +
		"      : true\n" +
		"  : false;\n" +
		`interface ${interfaceName} {\n${members.lines.join("\n")}\n}\n` +
		`declare const ${source.name}: ${interfaceName} & { [unknownAction: string]: never };\n`
	);
};

/**
 * Render replacement `declare const` blocks for guestTypeDeclarations(). Missing
 * or empty sections return nothing so the loose static lines survive.
 */
export const buildDynamicGuestDeclarations = (sources: CodeModeGuestTypeSources): CodeModeDynamicGuestDeclarations => {
	const dynamic: CodeModeDynamicGuestDeclarations = {};
	if (sources.mcpServers && sources.mcpServers.length > 0) {
		const mcp = renderMcpDeclaration(sources.mcpServers);
		if (mcp) dynamic.mcp = mcp;
	}
	if (sources.providers && sources.providers.length > 0) {
		const providers: Record<string, string> = {};
		for (const source of [...sources.providers].sort((left, right) => left.name.localeCompare(right.name))) {
			const declaration = renderProviderDeclaration(source);
			if (declaration) providers[source.name] = declaration;
		}
		if (Object.keys(providers).length > 0) dynamic.providers = providers;
	}
	return dynamic;
};
