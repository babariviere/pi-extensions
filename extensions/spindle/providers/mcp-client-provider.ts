/**
 * `mcp.*` on top of Spindle's own MCP client (`mcp/client-hub.ts`).
 *
 * Five management actions (`call`, `list`, `search`, `describe`, `connect`) plus
 * the `mcp.<server>.<tool>` ref form, all gated by `McpReadOnlyGate`.
 *
 * This replaced a bridge that forwarded to the pi-mcp-adapter `mcp` gateway
 * tool. The sandbox-visible surface is unchanged from that bridge on purpose
 * (same actions, same refs, same `{ text, content, structuredContent }` shape),
 * so no program had to change. What the in-tree client adds: no gateway hop, no
 * dependency on another extension being loaded, and a `describe` that returns
 * the server's real input schema instead of a permissive stub, because schemas
 * come from the on-disk tool cache rather than a forced connect.
 */

import type { CallToolResult } from "@modelcontextprotocol/client";
import { type McpToolHub, McpToolNotFoundError } from "../mcp/client-hub.ts";
import { McpReadOnlyGate } from "../mcp/read-only-policy.ts";
import type {
	SpindleActionDescriptor,
	SpindleInvocationContext,
	SpindleMcpServerTypeSource,
	SpindleMcpTypeSourceProvider,
	SpindleProvider,
	SpindleProviderListRequest,
} from "../protocol.ts";

const descriptors: SpindleActionDescriptor[] = [
	{
		name: "call",
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
		name: "list",
		description: "List MCP servers and their status from mcp.json (does not force a connect)",
		inputSchema: {
			type: "object",
			properties: { server: { type: "string" } },
			additionalProperties: false,
		},
		namespace: "management",
	},
	{
		name: "search",
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
		name: "describe",
		description: "Describe a single MCP tool, including its input schema",
		inputSchema: {
			type: "object",
			properties: { tool: { type: "string" }, server: { type: "string" } },
			required: ["tool"],
			additionalProperties: false,
		},
		namespace: "management",
	},
	{
		name: "connect",
		description: "Connect (lazy) a configured MCP server and refresh its tool metadata",
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

/** Same sandbox-visible shape the bridge produced, including throwing on `isError`. */
const normalizeResult = (result: CallToolResult): unknown => {
	const text = textFromContent(result.content);
	if (result.isError === true) throw new Error(text || "MCP tool returned an error");
	return {
		text,
		content: result.content,
		structuredContent: result.structuredContent ?? null,
	};
};

const parseQualifiedAction = (actionName: string): { server: string; tool: string } | undefined => {
	const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_.-]+)$/.exec(actionName.trim());
	if (!match?.[1] || !match[2]) return undefined;
	return { server: match[1], tool: match[2] };
};

const objectArgs = (value: unknown): Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const optionalString = (value: unknown): string | undefined =>
	typeof value === "string" && value.length > 0 ? value : undefined;

export class McpClientProvider implements SpindleProvider, SpindleMcpTypeSourceProvider {
	readonly name = "mcp";
	readonly description = "External MCP tools from mcp.json, called through Spindle's own MCP client (lazy connect)";

	constructor(
		readonly hub: () => McpToolHub,
		/**
		 * Read-only guardrail, read per call so a night run that starts (or ends)
		 * mid-session is picked up without re-registering the provider.
		 */
		readonly readOnlyGate: () => McpReadOnlyGate = () => McpReadOnlyGate.unrestricted(),
	) {}

	async list(
		_request: SpindleProviderListRequest,
		_context: SpindleInvocationContext,
	): Promise<SpindleActionDescriptor[]> {
		// Static only: listing tools here would connect every server (see the
		// no-pre-fetch rule in mcp/client-hub.ts).
		return descriptors;
	}

	async describe(
		actionName: string,
		_context: SpindleInvocationContext,
	): Promise<SpindleActionDescriptor | undefined> {
		const descriptor = descriptors.find((candidate) => candidate.name === actionName);
		if (descriptor) return descriptor;
		const qualified = parseQualifiedAction(actionName);
		if (!qualified) return undefined;
		// The cache makes a real schema available without connecting; the stub is
		// only used for a server whose tools have never been listed.
		const described = await this.hub().describeTool(qualified.tool, qualified.server);
		return {
			name: actionName,
			description: described?.description ?? `Call the MCP tool '${qualified.tool}' on server '${qualified.server}'`,
			inputSchema: described?.inputSchema ?? { type: "object", additionalProperties: true },
			namespace: `mcp:${qualified.server}`,
		};
	}

	async invoke(
		actionName: string,
		args: Record<string, unknown>,
		context: SpindleInvocationContext,
	): Promise<unknown> {
		switch (actionName) {
			case "call": {
				const server = optionalString(args.server);
				const tool = String(args.tool ?? "");
				// The one place a sandbox program can reach a write on an MCP server:
				// refused here, before the client is even asked to connect.
				this.readOnlyGate().assert(tool, server);
				return normalizeResult(
					await this.hub().callTool(tool, objectArgs(args.args), { signal: context.signal }, server),
				);
			}
			case "list": {
				const server = optionalString(args.server);
				return { servers: this.hub().status(server) };
			}
			case "search": {
				const server = optionalString(args.server);
				const found = await this.hub().searchTools(String(args.query ?? ""), {
					...(server ? { server } : {}),
					...(args.regex === true ? { regex: true } : {}),
				});
				if (args.includeSchemas === true) return { tools: found };
				return {
					tools: found.map(({ inputSchema: _inputSchema, outputSchema: _outputSchema, ...summary }) => summary),
				};
			}
			case "describe": {
				const tool = String(args.tool ?? "");
				const server = optionalString(args.server);
				const described = await this.hub().describeTool(tool, server);
				if (!described) throw new McpToolNotFoundError(tool);
				return described;
			}
			case "connect":
				return this.hub().connect(String(args.server ?? ""));
			default: {
				const qualified = parseQualifiedAction(actionName);
				if (!qualified) throw new Error(`Unknown mcp action: mcp.${actionName}`);
				this.readOnlyGate().assert(qualified.tool, qualified.server);
				return normalizeResult(
					await this.hub().callTool(
						qualified.tool,
						objectArgs(args.args ?? args),
						{ signal: context.signal },
						qualified.server,
					),
				);
			}
		}
	}

	/**
	 * Cached tool schemas for the generated `mcp` guest surface, grouped by
	 * server. Cache-only by construction (see `McpToolHub.cachedTools`), so
	 * type generation cannot connect a server or provoke an OAuth prompt.
	 */
	async mcpGuestTypeSources(_context: SpindleInvocationContext): Promise<SpindleMcpServerTypeSource[]> {
		const grouped = new Map<string, SpindleMcpServerTypeSource>();
		for (const tool of await this.hub().cachedTools()) {
			const entry = grouped.get(tool.server) ?? { server: tool.server, tools: [] };
			entry.tools.push({ name: tool.name, inputSchema: tool.inputSchema });
			grouped.set(tool.server, entry);
		}
		return [...grouped.values()];
	}

	async close(): Promise<void> {
		await this.hub().close();
	}
}
