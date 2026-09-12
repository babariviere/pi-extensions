/**
 * Spindle's own MCP client.
 *
 * Replaces the pi-mcp-adapter gateway hop: `mcp.*` used to be a tool call into
 * the adapter, which re-resolved the server and tool by name, called it, and
 * handed back `{content}` that Spindle re-parsed. Here a call is a method call
 * on a `Client` this process owns.
 *
 * Design rules, inherited from the bridge because they were right:
 *  1. Fail at use, never at startup. Constructing the hub touches nothing.
 *  2. No pre-fetch. Servers connect lazily and metadata reads are served from
 *     the on-disk tool cache, so discovery never triggers an OAuth prompt.
 */

import type { CallToolResult, Tool, Transport } from "@modelcontextprotocol/client";
import { Client, StreamableHTTPClientTransport, UnauthorizedError } from "@modelcontextprotocol/client";

import { McpAuthorizationRequiredError, McpOAuthProvider } from "./oauth-provider.ts";
import {
	isToolAllowed,
	loadMcpServerConfig,
	mcpConfigFingerprint,
	mcpRedirectUrl,
	type McpServerConfig,
	type McpServerDefinition,
	prefixedToolName,
	usesOAuth,
} from "./server-config.ts";
import { defaultMcpKeyring, McpTokenStore } from "./token-store.ts";
import { type CachedMcpTool, McpToolCache } from "./tool-cache.ts";

const CLIENT_INFO = { name: "pi-spindle", version: "1.0.0" };

export type McpServerState = "connected" | "idle" | "needs-auth" | "failed" | "disabled" | "unsupported";

export interface McpServerStatus {
	name: string;
	state: McpServerState;
	transport: McpServerDefinition["transport"];
	target?: string;
	/** Tool count, from the live connection when connected, else from the cache. */
	tools?: number;
	/** Present for `failed`, `needs-auth` and `unsupported`. */
	detail?: string;
	/** True when the tool list came from the on-disk cache rather than a live list. */
	cached?: boolean;
}

export interface McpToolSummary {
	server: string;
	name: string;
	/** The adapter-compatible prefixed name, kept so read-only policy keys still match. */
	prefixed: string;
	description?: string;
}

export interface McpToolDescription extends McpToolSummary {
	inputSchema: Record<string, unknown>;
	outputSchema?: Record<string, unknown>;
	annotations?: Record<string, unknown>;
}

export interface McpCallContext {
	signal?: AbortSignal | undefined;
}

/** The surface the Spindle provider needs; a test supplies a fake instead of a network. */
export interface McpToolHub {
	status(server?: string): McpServerStatus[];
	listTools(server?: string): Promise<McpToolSummary[]>;
	describeTool(ref: string, server?: string): Promise<McpToolDescription | undefined>;
	/**
	 * Every tool schema already on disk, grouped nowhere and connecting nothing.
	 * Feeds guest type generation, which must stay side-effect free.
	 */
	cachedTools(): Promise<McpToolDescription[]>;
	searchTools(query: string, options?: { server?: string; regex?: boolean }): Promise<McpToolDescription[]>;
	connect(server: string): Promise<McpServerStatus>;
	callTool(
		tool: string,
		args: Record<string, unknown>,
		context: McpCallContext,
		server?: string,
	): Promise<CallToolResult>;
	close(): Promise<void>;
}

export class McpServerNotConfiguredError extends Error {
	constructor(serverName: string, configured: string[]) {
		super(
			configured.length === 0
				? `No MCP server is configured. Add one to ${"~/.pi/agent/mcp.json"}.`
				: `Unknown MCP server '${serverName}'. Configured: ${configured.join(", ")}.`,
		);
		this.name = "McpServerNotConfiguredError";
	}
}

export class McpToolNotFoundError extends Error {
	constructor(ref: string) {
		super(
			`Unknown MCP tool '${ref}'. Use mcp.search({ query }) to find one, or mcp.connect({ server }) to refresh its tools.`,
		);
		this.name = "McpToolNotFoundError";
	}
}

interface Connection {
	client: Client;
	transport: Transport;
	tools: CachedMcpTool[];
}

const toCachedTool = (tool: Tool): CachedMcpTool => {
	const cached: CachedMcpTool = { name: tool.name };
	const description = typeof tool.description === "string" ? tool.description : undefined;
	if (description) cached.description = description;
	if (tool.inputSchema && typeof tool.inputSchema === "object") {
		cached.inputSchema = tool.inputSchema as Record<string, unknown>;
	}
	const outputSchema = (tool as { outputSchema?: unknown }).outputSchema;
	if (outputSchema && typeof outputSchema === "object") cached.outputSchema = outputSchema as Record<string, unknown>;
	if (tool.annotations && typeof tool.annotations === "object") {
		cached.annotations = tool.annotations as Record<string, unknown>;
	}
	return cached;
};

const serverTarget = (definition: McpServerDefinition): string =>
	definition.url ?? [definition.command, ...(definition.args ?? [])].join(" ");

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface McpClientHubOptions {
	cwd: string;
	store?: McpTokenStore;
	cache?: McpToolCache;
	loadConfig?: (cwd: string) => McpServerConfig;
	fingerprint?: (cwd: string) => string;
	/** Called whenever a connection is opened, dropped or fails, so a UI can refresh. */
	onStatusChange?: () => void;
}

export class McpClientHub implements McpToolHub {
	readonly #options: McpClientHubOptions;
	readonly #connections = new Map<string, Connection>();
	readonly #failures = new Map<string, { state: "needs-auth" | "failed"; detail: string }>();
	#config: { fingerprint: string; value: McpServerConfig } | undefined;
	#store: McpTokenStore | undefined;
	#cache: McpToolCache | undefined;

	constructor(options: McpClientHubOptions) {
		this.#options = options;
	}

	/** Best-effort notification; a broken listener must never break a call. */
	#statusChanged(): void {
		try {
			this.#options.onStatusChange?.();
		} catch {
			// A UI refresh is cosmetic.
		}
	}

	#fingerprint(): string {
		return (this.#options.fingerprint ?? mcpConfigFingerprint)(this.#options.cwd);
	}

	#configuration(): McpServerConfig {
		const fingerprint = this.#fingerprint();
		if (this.#config?.fingerprint === fingerprint) return this.#config.value;
		const value = (this.#options.loadConfig ?? loadMcpServerConfig)(this.#options.cwd);
		this.#config = { fingerprint, value };
		return value;
	}

	#definition(serverName: string): McpServerDefinition {
		const config = this.#configuration();
		const definition = config.servers.find((candidate) => candidate.name === serverName);
		if (!definition)
			throw new McpServerNotConfiguredError(
				serverName,
				config.servers.map((candidate) => candidate.name),
			);
		return definition;
	}

	#tokenStore(): McpTokenStore {
		this.#store ??= this.#options.store ?? new McpTokenStore(defaultMcpKeyring());
		return this.#store;
	}

	#toolCache(): McpToolCache {
		this.#cache ??= this.#options.cache ?? new McpToolCache();
		return this.#cache;
	}

	status(server?: string): McpServerStatus[] {
		const config = this.#configuration();
		const fingerprint = this.#fingerprint();
		const definitions = server ? config.servers.filter((candidate) => candidate.name === server) : config.servers;
		return definitions.map((definition) => {
			const target = serverTarget(definition);
			const base: McpServerStatus = {
				name: definition.name,
				state: "idle",
				transport: definition.transport,
				target,
			};
			if (definition.disabled) return { ...base, state: "disabled" };
			if (definition.transport === "unsupported") {
				return { ...base, state: "unsupported", detail: definition.unsupported ?? "unsupported entry" };
			}
			const connection = this.#connections.get(definition.name);
			if (connection) return { ...base, state: "connected", tools: connection.tools.length };
			const failure = this.#failures.get(definition.name);
			if (failure) return { ...base, state: failure.state, detail: failure.detail };
			const cached = this.#toolCache().get(definition.name, target, fingerprint);
			if (cached) return { ...base, tools: cached.tools.length, cached: true };
			return base;
		});
	}

	async connect(server: string): Promise<McpServerStatus> {
		await this.#connection(server, { refresh: true });
		const status = this.status(server)[0];
		if (!status) throw new McpServerNotConfiguredError(server, []);
		return status;
	}

	async #connection(serverName: string, options: { refresh?: boolean } = {}): Promise<Connection> {
		const existing = this.#connections.get(serverName);
		if (existing && !options.refresh) return existing;
		const definition = this.#definition(serverName);
		if (definition.disabled) throw new Error(`MCP server '${serverName}' is disabled in mcp.json.`);
		if (definition.transport === "unsupported") {
			throw new Error(`MCP server '${serverName}' cannot be used: ${definition.unsupported}`);
		}
		if (existing) await this.#drop(serverName);
		try {
			const connection = await this.#open(definition);
			this.#connections.set(serverName, connection);
			this.#failures.delete(serverName);
			this.#toolCache().set(serverName, serverTarget(definition), this.#fingerprint(), connection.tools);
			this.#statusChanged();
			return connection;
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			const needsAuth = error instanceof UnauthorizedError || error instanceof McpAuthorizationRequiredError;
			this.#failures.set(serverName, { state: needsAuth ? "needs-auth" : "failed", detail });
			this.#statusChanged();
			throw error;
		}
	}

	async #open(definition: McpServerDefinition): Promise<Connection> {
		const transport = await this.#transport(definition);
		const client = new Client(CLIENT_INFO, { capabilities: {} });
		await client.connect(transport);
		const listed = await client.listTools();
		const tools = listed.tools.filter((tool) => isToolAllowed(definition, tool.name)).map(toCachedTool);
		return { client, transport, tools };
	}

	async #transport(definition: McpServerDefinition): Promise<Transport> {
		if (definition.transport === "stdio") {
			const { StdioClientTransport } = await import("@modelcontextprotocol/client/stdio");
			return new StdioClientTransport({
				command: String(definition.command),
				args: definition.args ?? [],
				...(definition.env ? { env: { ...(process.env as Record<string, string>), ...definition.env } } : {}),
				...(definition.serverCwd ? { cwd: definition.serverCwd } : {}),
			}) as unknown as Transport;
		}
		const url = new URL(String(definition.url));
		const headers: Record<string, string> = { ...(definition.headers ?? {}) };
		const bearer =
			definition.bearerToken ?? (definition.bearerTokenEnv ? process.env[definition.bearerTokenEnv] : undefined);
		if (bearer) headers.Authorization = `Bearer ${bearer}`;
		const options: Record<string, unknown> = {};
		if (Object.keys(headers).length > 0) options.requestInit = { headers };
		if (usesOAuth(definition)) {
			const oauthConfig =
				definition.oauth === false || definition.oauth === undefined ? undefined : definition.oauth;
			const provider = new McpOAuthProvider({
				serverName: definition.name,
				serverUrl: url.toString(),
				store: this.#tokenStore(),
				// Required even though this path can never open a browser: the SDK
				// reads `redirectUrl` to choose a grant, and without it treats the
				// provider as client-credentials, skipping the refresh-token branch of
				// `auth()` and failing an expired-but-refreshable server outright.
				// Non-interactivity still holds: `redirectToAuthorization` throws
				// `McpAuthorizationRequiredError` because no `onRedirect` is supplied.
				redirectUrl: mcpRedirectUrl(definition),
				...(oauthConfig ? { config: oauthConfig } : {}),
			});
			options.authProvider = provider;
			if (oauthConfig?.skipIssuerMetadataValidation) options.skipIssuerMetadataValidation = true;
		}
		return new StreamableHTTPClientTransport(url, options) as unknown as Transport;
	}

	async #drop(serverName: string): Promise<void> {
		const connection = this.#connections.get(serverName);
		this.#connections.delete(serverName);
		if (!connection) return;
		this.#statusChanged();
		try {
			await connection.client.close();
		} catch {
			// A server that is already gone does not need closing.
		}
	}

	/** Cached tools when valid, else a live list (which connects). */
	async #toolsFor(
		definition: McpServerDefinition,
		options: { allowConnect?: boolean } = {},
	): Promise<CachedMcpTool[]> {
		const connection = this.#connections.get(definition.name);
		if (connection) return connection.tools.filter((tool) => isToolAllowed(definition, tool.name));
		const cached = this.#toolCache().get(definition.name, serverTarget(definition), this.#fingerprint());
		if (cached) return cached.tools.filter((tool) => isToolAllowed(definition, tool.name));
		if (options.allowConnect === false) return [];
		return (await this.#connection(definition.name)).tools;
	}

	#usableServers(server?: string): McpServerDefinition[] {
		return this.#configuration()
			.servers.filter((definition) => !definition.disabled && definition.transport !== "unsupported")
			.filter((definition) => server === undefined || definition.name === server);
	}

	async listTools(server?: string): Promise<McpToolSummary[]> {
		const summaries: McpToolSummary[] = [];
		for (const definition of this.#usableServers(server)) {
			// A metadata read must never connect: an unconnected, uncached server
			// simply contributes nothing until mcp.connect() or a call warms it.
			const tools = await this.#toolsFor(definition, { allowConnect: false });
			for (const tool of tools) {
				const summary: McpToolSummary = {
					server: definition.name,
					name: tool.name,
					prefixed: prefixedToolName(definition.name, tool.name),
				};
				if (tool.description) summary.description = tool.description;
				summaries.push(summary);
			}
		}
		return summaries;
	}

	async #describedTools(server?: string): Promise<McpToolDescription[]> {
		const described: McpToolDescription[] = [];
		for (const definition of this.#usableServers(server)) {
			for (const tool of await this.#toolsFor(definition, { allowConnect: false })) {
				const description: McpToolDescription = {
					server: definition.name,
					name: tool.name,
					prefixed: prefixedToolName(definition.name, tool.name),
					inputSchema: tool.inputSchema ?? { type: "object", additionalProperties: true },
				};
				if (tool.description) description.description = tool.description;
				if (tool.outputSchema) description.outputSchema = tool.outputSchema;
				if (tool.annotations) description.annotations = tool.annotations;
				described.push(description);
			}
		}
		return described;
	}

	async cachedTools(): Promise<McpToolDescription[]> {
		return this.#describedTools();
	}

	async describeTool(ref: string, server?: string): Promise<McpToolDescription | undefined> {
		const resolved = this.#parseRef(ref, server);
		const candidates = await this.#describedTools(resolved.server);
		return candidates.find(
			(candidate) =>
				candidate.name === resolved.tool || candidate.prefixed === resolved.tool || candidate.prefixed === ref,
		);
	}

	async searchTools(query: string, options: { server?: string; regex?: boolean } = {}): Promise<McpToolDescription[]> {
		const pattern = new RegExp(options.regex === true ? query : escapeRegExp(query), "i");
		const described = await this.#describedTools(options.server);
		return described.filter(
			(tool) => pattern.test(tool.name) || pattern.test(tool.prefixed) || pattern.test(tool.description ?? ""),
		);
	}

	/** `server.tool`, `mcp_server_tool`, or a bare tool name with an optional explicit server. */
	#parseRef(ref: string, server?: string): { server?: string; tool: string } {
		const trimmed = ref.trim();
		if (server) return { server, tool: trimmed };
		const dotted = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_.-]+)$/.exec(trimmed);
		if (dotted?.[1] && dotted[2] && this.#configuration().servers.some((candidate) => candidate.name === dotted[1])) {
			return { server: dotted[1], tool: dotted[2] };
		}
		for (const definition of this.#configuration().servers) {
			const prefix = `mcp_${definition.name.replace(/-/g, "_")}_`;
			if (trimmed.startsWith(prefix)) return { server: definition.name, tool: trimmed.slice(prefix.length) };
		}
		return { tool: trimmed };
	}

	/** The server that actually owns a tool, connecting only when a cache miss forces it. */
	async #locate(tool: string, server?: string): Promise<{ definition: McpServerDefinition; tool: string }> {
		const resolved = this.#parseRef(tool, server);
		if (resolved.server) return { definition: this.#definition(resolved.server), tool: resolved.tool };
		for (const definition of this.#usableServers()) {
			const tools = await this.#toolsFor(definition, { allowConnect: false });
			if (tools.some((candidate) => candidate.name === resolved.tool)) return { definition, tool: resolved.tool };
		}
		// Nothing cached knows the name: warm each server once before giving up.
		for (const definition of this.#usableServers()) {
			const tools = await this.#toolsFor(definition);
			if (tools.some((candidate) => candidate.name === resolved.tool)) return { definition, tool: resolved.tool };
		}
		throw new McpToolNotFoundError(tool);
	}

	async callTool(
		tool: string,
		args: Record<string, unknown>,
		context: McpCallContext,
		server?: string,
	): Promise<CallToolResult> {
		const located = await this.#locate(tool, server);
		if (!isToolAllowed(located.definition, located.tool)) {
			throw new Error(
				`MCP tool '${located.tool}' is filtered out for server '${located.definition.name}' by includeTools/excludeTools in mcp.json.`,
			);
		}
		const connection = await this.#connection(located.definition.name);
		const options: Record<string, unknown> = {};
		if (context.signal) options.signal = context.signal;
		if (located.definition.requestTimeoutMs) options.timeout = located.definition.requestTimeoutMs;
		return connection.client.callTool({ name: located.tool, arguments: args }, options);
	}

	async close(): Promise<void> {
		await Promise.all([...this.#connections.keys()].map((serverName) => this.#drop(serverName)));
	}
}
