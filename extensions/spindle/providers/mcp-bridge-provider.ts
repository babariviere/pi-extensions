/**
 * `mcp.*` bridge to the sibling `pi-mcp-adapter` extension.
 *
 * Spindle does NOT embed an MCP client. Instead it forwards to the `mcp`
 * gateway tool that `pi-mcp-adapter` registers, so `~/.pi/agent/mcp.json`,
 * `mcp-auth.json`, keyring credentials, and per-server/per-tool disable rules
 * keep working unchanged.
 *
 * Two hard rules:
 *  1. Fail at use, never at startup. The constructor must not touch the
 *     catalog; a missing adapter surfaces as an actionable in-sandbox error.
 *  2. No pre-fetch. `pi-mcp-adapter` connects servers lazily; eagerly listing
 *     tools would force every server to connect and can trigger OAuth flows.
 *     `list()`/`describe()` therefore return static descriptors only.
 */

import { runAbortable } from "../async-settlement.ts";
import type { CapturedToolCatalog, CapturedToolEntry } from "../capture/catalog.ts";
import type {
	SpindleActionDescriptor,
	SpindleInvocationContext,
	SpindleProvider,
	SpindleProviderListRequest,
} from "../protocol.ts";

const MISSING_ADAPTER_MESSAGE =
	"spindle: the 'mcp' namespace requires the pi-mcp-adapter extension, which is not loaded. " +
	"Install/enable pi-mcp-adapter, or remove mcp.* from this program.";

const emptyObjectSchema = {
	type: "object",
	properties: {},
	additionalProperties: false,
};

const descriptors: SpindleActionDescriptor[] = [
	{
		name: "$call",
		description: "Call an MCP tool by explicit server and tool name",
		inputSchema: {
			type: "object",
			properties: {
				server: { type: "string" },
				tool: { type: "string" },
				args: { type: "object", additionalProperties: true },
			},
			required: ["tool"],
			additionalProperties: false,
		},
		namespace: "management",
	},
	{
		name: "$list",
		description: "List MCP servers and their status as reported by pi-mcp-adapter (does not force a connect)",
		inputSchema: {
			type: "object",
			properties: { server: { type: "string" } },
			additionalProperties: false,
		},
		namespace: "management",
	},
	{
		name: "$search",
		description: "Search MCP tools by query across configured servers",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string" },
				server: { type: "string" },
				regex: { type: "boolean" },
				includeSchemas: { type: "boolean" },
			},
			required: ["query"],
			additionalProperties: false,
		},
		namespace: "management",
	},
	{
		name: "$describe",
		description: "Describe a single MCP tool, including its input schema",
		inputSchema: {
			type: "object",
			properties: { tool: { type: "string" } },
			required: ["tool"],
			additionalProperties: false,
		},
		namespace: "management",
	},
	{
		name: "$connect",
		description:
			"Connect (lazy) a configured MCP server and refresh its tool metadata; matches the pi-mcp-adapter mcp({ connect }) hint",
		inputSchema: {
			type: "object",
			properties: { server: { type: "string" } },
			required: ["server"],
			additionalProperties: false,
		},
		namespace: "management",
	},
];

const textFromContent = (content: unknown): string => {
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(part): part is { type: "text"; text: string } =>
				typeof part === "object" &&
				part !== null &&
				(part as Record<string, unknown>).type === "text" &&
				typeof (part as Record<string, unknown>).text === "string",
		)
		.map((part) => part.text)
		.join("\n");
};

/**
 * Copied from the deleted upstream `src/providers/mcp-provider.ts` so the
 * sandbox-visible result shape stays `{ text, content, structuredContent }`
 * and an `isError` result rejects instead of returning silently.
 */
const normalizeMcpResult = (result: unknown): unknown => {
	if (typeof result !== "object" || result === null || Array.isArray(result)) return result;
	const record = result as Record<string, unknown>;
	if (!Array.isArray(record.content)) return result;
	const text = textFromContent(record.content);
	if (record.isError === true) throw new Error(text || "MCP tool returned an error");
	return {
		text,
		content: record.content,
		structuredContent: record.structuredContent ?? null,
	};
};

const objectArgs = (value: unknown): Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

export class McpBridgeProvider implements SpindleProvider {
	readonly name = "mcp";
	readonly description = "External MCP tools reached through the pi-mcp-adapter `mcp` gateway tool (lazy connect)";

	constructor(readonly catalog: () => CapturedToolCatalog) {}

	async list(
		_request: SpindleProviderListRequest,
		_context: SpindleInvocationContext,
	): Promise<SpindleActionDescriptor[]> {
		// Static only: never call the gateway here (see the no-pre-fetch rule).
		return descriptors;
	}

	async describe(
		actionName: string,
		_context: SpindleInvocationContext,
	): Promise<SpindleActionDescriptor | undefined> {
		return descriptors.find((descriptor) => descriptor.name === actionName);
	}

	async invoke(
		actionName: string,
		args: Record<string, unknown>,
		context: SpindleInvocationContext,
	): Promise<unknown> {
		switch (actionName) {
			case "$call": {
				const server = typeof args.server === "string" ? args.server : undefined;
				return this.#gatewayCall(
					{
						tool: String(args.tool ?? ""),
						args: objectArgs(args.args),
						...(server ? { server } : {}),
					},
					context,
				);
			}
			case "$list": {
				const server = typeof args.server === "string" ? args.server : undefined;
				return this.#gatewayCall(server ? { server } : {}, context);
			}
			case "$search": {
				const server = typeof args.server === "string" ? args.server : undefined;
				return this.#gatewayCall(
					{
						search: String(args.query ?? ""),
						...(server ? { server } : {}),
						...(args.regex === true ? { regex: true } : {}),
						...(args.includeSchemas === true ? { includeSchemas: true } : {}),
					},
					context,
				);
			}
			case "$describe":
				return this.#gatewayCall({ describe: String(args.tool ?? "") }, context);
			case "$connect":
				return this.#gatewayCall({ connect: String(args.server ?? "") }, context);
			default:
				throw new Error(`Unknown mcp action: mcp.${actionName}`);
		}
	}

	#gateway(): CapturedToolEntry {
		const entry = this.catalog().get("mcp");
		if (!entry) throw new Error(MISSING_ADAPTER_MESSAGE);
		return entry;
	}

	async #gatewayCall(params: Record<string, unknown>, context: SpindleInvocationContext): Promise<unknown> {
		const entry = this.#gateway();
		const result = await runAbortable(context.signal, () =>
			entry.wrappedTool.execute(context.nestedToolCallId, params, context.signal, () => {}),
		);
		// `AgentToolResult` carries no `isError`; the gateway signals failure by
		// throwing, or (defensively) via an `isError` flag on its details payload.
		const details =
			typeof result.details === "object" && result.details !== null
				? (result.details as Record<string, unknown>)
				: undefined;
		if (details?.isError === true) {
			throw new Error(textFromContent(result.content) || "The pi-mcp-adapter gateway returned an error");
		}
		return normalizeMcpResult({
			content: result.content,
			...(result.details !== undefined ? { structuredContent: result.details } : {}),
		});
	}
}
