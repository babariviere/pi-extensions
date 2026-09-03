/**
 * `mcp.json` loader for Spindle's own MCP client.
 *
 * Field-compatible with pi-mcp-adapter's config on purpose: the same
 * `~/.pi/agent/mcp.json` drives either client, so switching between them needs
 * no config edit and no re-auth. Only the subset Spindle can actually honor is
 * read; an entry Spindle cannot run is kept and marked `unsupported` so
 * `mcp.list()` reports it instead of silently dropping a configured server.
 *
 * Layers, lowest precedence first:
 *   1. `$PI_AGENT_DIR/mcp.json` (default `~/.pi/agent/mcp.json`)
 *   2. `<cwd>/.pi/mcp.json`
 *   3. `<cwd>/.mcp.json`
 *
 * Merging is per field, and credentials are URL-bound: when a higher layer
 * changes `url`, credential fields inherited from a lower layer are dropped
 * rather than shipped to a different endpoint.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type McpAuthMode = "oauth" | "bearer" | false;

export interface McpOAuthConfig {
	scopes?: string[];
	clientId?: string;
	clientSecret?: string;
	/** Fixed loopback port for the redirect URI; ephemeral when absent. */
	redirectPort?: number;
	authServerMetadataUrl?: string;
	skipIssuerMetadataValidation?: boolean;
}

export interface McpServerDefinition {
	name: string;
	transport: "http" | "stdio" | "unsupported";
	url?: string;
	headers?: Record<string, string>;
	auth?: McpAuthMode;
	bearerToken?: string;
	bearerTokenEnv?: string;
	oauth?: McpOAuthConfig | false;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	/** Working directory for a stdio server, named to avoid clashing with the invocation cwd. */
	serverCwd?: string;
	includeTools?: string[];
	excludeTools?: string[];
	/** Read for reporting only: Spindle reaches every tool through `mcp.*`. */
	directTools?: boolean | string[];
	requestTimeoutMs?: number;
	disabled: boolean;
	/** Why this client cannot run the entry, when `transport` is `"unsupported"`. */
	unsupported?: string;
	/** Config layers that contributed to the effective entry, lowest precedence first. */
	sources: string[];
}

export interface McpServerConfig {
	servers: McpServerDefinition[];
	/** Every layer path considered, present or not. */
	layers: string[];
	/** Parse failures, one per unreadable layer. Never thrown: a broken project layer must not kill the session. */
	errors: string[];
}

const CREDENTIAL_FIELDS = ["headers", "auth", "bearerToken", "bearerTokenEnv", "oauth"] as const;

export const mcpAgentDir = (): string => process.env.PI_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");

export const mcpConfigLayerPaths = (cwd: string): string[] => {
	const layers = [path.join(mcpAgentDir(), "mcp.json")];
	if (typeof cwd === "string" && cwd.length > 0) {
		layers.push(path.join(cwd, ".pi", "mcp.json"), path.join(cwd, ".mcp.json"));
	}
	return layers;
};

/** mtime + size of every layer, so a cache can be invalidated by an edit. */
export const mcpConfigFingerprint = (cwd: string, statFile: typeof fs.statSync = fs.statSync): string =>
	mcpConfigLayerPaths(cwd)
		.map((layerPath) => {
			try {
				const stat = statFile(layerPath);
				return `${layerPath}:${stat.mtimeMs}:${stat.size}`;
			} catch {
				return `${layerPath}:absent`;
			}
		})
		.join("|");

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const asStringArray = (value: unknown): string[] | undefined =>
	Array.isArray(value) && value.every((item) => typeof item === "string") ? (value as string[]) : undefined;

const asStringMap = (value: unknown): Record<string, string> | undefined => {
	const record = asRecord(value);
	if (!record) return undefined;
	const out: Record<string, string> = {};
	for (const [key, entry] of Object.entries(record)) {
		if (typeof entry === "string") out[key] = entry;
	}
	return out;
};

const asPositiveInt = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;

const readAuthMode = (value: unknown): McpAuthMode | undefined => {
	if (value === false) return false;
	if (value === "oauth" || value === "bearer") return value;
	return undefined;
};

const readOAuth = (value: unknown): McpOAuthConfig | false | undefined => {
	if (value === false) return false;
	const record = asRecord(value);
	if (!record) return undefined;
	const scopes =
		asStringArray(record.scopes) ?? (asString(record.scope) ? asString(record.scope)?.split(/\s+/) : undefined);
	const config: McpOAuthConfig = {};
	if (scopes && scopes.length > 0) config.scopes = scopes;
	const clientId = asString(record.clientId);
	if (clientId) config.clientId = clientId;
	const clientSecret = asString(record.clientSecret);
	if (clientSecret) config.clientSecret = clientSecret;
	const redirectPort = asPositiveInt(record.redirectPort);
	if (redirectPort) config.redirectPort = redirectPort;
	const metadataUrl = asString(record.authServerMetadataUrl);
	if (metadataUrl) config.authServerMetadataUrl = metadataUrl;
	if (record.skipIssuerMetadataValidation === true) config.skipIssuerMetadataValidation = true;
	return config;
};

/** One raw layer entry, normalized but not yet merged. */
type PartialDefinition = Partial<Omit<McpServerDefinition, "name" | "sources" | "transport" | "disabled">> & {
	disabled?: boolean;
	/** Set when the entry names a transport this client does not implement. */
	unsupported?: string;
};

const readEntry = (raw: unknown): PartialDefinition | undefined => {
	const record = asRecord(raw);
	if (!record) return undefined;
	const entry: PartialDefinition = {};
	const url = asString(record.url);
	if (url) entry.url = url;
	const headers = asStringMap(record.headers);
	if (headers && Object.keys(headers).length > 0) entry.headers = headers;
	const auth = readAuthMode(record.auth);
	if (auth !== undefined) entry.auth = auth;
	const bearerToken = asString(record.bearerToken);
	if (bearerToken) entry.bearerToken = bearerToken;
	const bearerTokenEnv = asString(record.bearerTokenEnv);
	if (bearerTokenEnv) entry.bearerTokenEnv = bearerTokenEnv;
	const oauth = readOAuth(record.oauth);
	if (oauth !== undefined) entry.oauth = oauth;
	const command = asString(record.command);
	if (command) entry.command = command;
	const args = asStringArray(record.args);
	if (args) entry.args = args;
	const env = asStringMap(record.env);
	if (env && Object.keys(env).length > 0) entry.env = env;
	const serverCwd = asString(record.cwd);
	if (serverCwd) entry.serverCwd = serverCwd;
	const includeTools = asStringArray(record.includeTools);
	if (includeTools) entry.includeTools = includeTools;
	const excludeTools = asStringArray(record.excludeTools);
	if (excludeTools) entry.excludeTools = excludeTools;
	if (typeof record.directTools === "boolean") entry.directTools = record.directTools;
	const directToolList = asStringArray(record.directTools);
	if (directToolList) entry.directTools = directToolList;
	const requestTimeoutMs = asPositiveInt(record.requestTimeoutMs);
	if (requestTimeoutMs) entry.requestTimeoutMs = requestTimeoutMs;
	if (record.disabled === true) entry.disabled = true;
	if (record.disabled === false) entry.disabled = false;
	if (asString(record.socket))
		entry.unsupported = "rmcp-mux unix socket transport is not implemented by the Spindle MCP client";
	if (asRecord(record.requestHeadersCommand)) {
		entry.unsupported = "requestHeadersCommand is not implemented by the Spindle MCP client";
	}
	return entry;
};

const readLayer = (
	layerPath: string,
	readFile: (filePath: string) => string,
): { entries: Map<string, PartialDefinition> } | { error: string } => {
	let text: string;
	try {
		text = readFile(layerPath);
	} catch {
		return { entries: new Map() };
	}
	let document: unknown;
	try {
		document = JSON.parse(text);
	} catch (error) {
		return { error: `${layerPath}: ${error instanceof Error ? error.message : String(error)}` };
	}
	const root = asRecord(document);
	if (!root) return { error: `${layerPath}: expected a JSON object` };
	const servers = asRecord(root.mcpServers) ?? asRecord(root.servers);
	if (!servers) return { entries: new Map() };
	const entries = new Map<string, PartialDefinition>();
	for (const [name, raw] of Object.entries(servers)) {
		const entry = readEntry(raw);
		if (entry) entries.set(name, entry);
	}
	return { entries };
};

const resolveTransport = (
	merged: PartialDefinition,
): { transport: McpServerDefinition["transport"]; unsupported?: string } => {
	if (merged.unsupported) return { transport: "unsupported", unsupported: merged.unsupported };
	if (merged.url) return { transport: "http" };
	if (merged.command) return { transport: "stdio" };
	return { transport: "unsupported", unsupported: "entry declares neither url nor command" };
};

/**
 * Fold one layer over the accumulated entry.
 *
 * A layer that changes `url` invalidates every credential the lower layers
 * contributed, because a token minted for one endpoint must never be sent to
 * another. Credentials the *same* layer supplies alongside the new url are kept.
 */
const mergeEntry = (base: PartialDefinition | undefined, next: PartialDefinition): PartialDefinition => {
	if (!base) return { ...next };
	const rebound = next.url !== undefined && base.url !== undefined && next.url !== base.url;
	const carried: PartialDefinition = { ...base };
	if (rebound) {
		for (const field of CREDENTIAL_FIELDS) delete carried[field];
	}
	return { ...carried, ...next };
};

export const loadMcpServerConfig = (
	cwd: string,
	options: { readFile?: (filePath: string) => string } = {},
): McpServerConfig => {
	const readFile = options.readFile ?? ((filePath: string) => fs.readFileSync(filePath, "utf8"));
	const layers = mcpConfigLayerPaths(cwd);
	const errors: string[] = [];
	const merged = new Map<string, { entry: PartialDefinition; sources: string[] }>();
	for (const layerPath of layers) {
		const result = readLayer(layerPath, readFile);
		if ("error" in result) {
			errors.push(result.error);
			continue;
		}
		for (const [name, entry] of result.entries) {
			const previous = merged.get(name);
			merged.set(name, {
				entry: mergeEntry(previous?.entry, entry),
				sources: [...(previous?.sources ?? []), layerPath],
			});
		}
	}
	const servers = [...merged.entries()].map(([name, { entry, sources }]) => {
		const { transport, unsupported } = resolveTransport(entry);
		const definition: McpServerDefinition = {
			name,
			transport,
			disabled: entry.disabled === true,
			sources,
		};
		if (unsupported) definition.unsupported = unsupported;
		if (entry.url) definition.url = entry.url;
		if (entry.headers) definition.headers = entry.headers;
		if (entry.auth !== undefined) definition.auth = entry.auth;
		if (entry.bearerToken) definition.bearerToken = entry.bearerToken;
		if (entry.bearerTokenEnv) definition.bearerTokenEnv = entry.bearerTokenEnv;
		if (entry.oauth !== undefined) definition.oauth = entry.oauth;
		if (entry.command) definition.command = entry.command;
		if (entry.args) definition.args = entry.args;
		if (entry.env) definition.env = entry.env;
		if (entry.serverCwd) definition.serverCwd = entry.serverCwd;
		if (entry.includeTools) definition.includeTools = entry.includeTools;
		if (entry.excludeTools) definition.excludeTools = entry.excludeTools;
		if (entry.directTools !== undefined) definition.directTools = entry.directTools;
		if (entry.requestTimeoutMs) definition.requestTimeoutMs = entry.requestTimeoutMs;
		return definition;
	});
	servers.sort((left, right) => left.name.localeCompare(right.name));
	return { servers, layers, errors };
};

/**
 * Whether OAuth applies to a server.
 *
 * Mirrors the adapter's precedence: an explicit `auth` wins, a literal or
 * env-sourced bearer token opts out, custom headers opt out (they are assumed
 * to carry the credential), and any other HTTP server auto-detects OAuth.
 */
export const usesOAuth = (definition: McpServerDefinition): boolean => {
	if (definition.transport !== "http") return false;
	if (definition.auth === "oauth") return true;
	if (definition.auth === "bearer" || definition.auth === false) return false;
	if (definition.oauth === false) return false;
	if (definition.bearerToken || definition.bearerTokenEnv) return false;
	if (definition.headers && Object.keys(definition.headers).length > 0) return false;
	return true;
};

/**
 * Fixed by default: a dynamically registered OAuth client is bound to the exact
 * redirect URI it registered, so an ephemeral port would force a fresh client
 * registration on every authorization.
 */
export const DEFAULT_MCP_REDIRECT_PORT = 33418;
export const MCP_REDIRECT_PATH = "/callback";

export const mcpRedirectPort = (definition: McpServerDefinition): number => {
	const oauth = definition.oauth === false || definition.oauth === undefined ? undefined : definition.oauth;
	const configured = oauth?.redirectPort;
	if (configured) return configured;
	const fromEnv = Number(process.env.SPINDLE_MCP_REDIRECT_PORT);
	return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_MCP_REDIRECT_PORT;
};

/**
 * The loopback redirect URI for a server, identical whether it comes from the
 * `/mcp-auth` flow or from a plain tool call. It must be set even when nobody
 * can open a browser: the SDK reads `provider.redirectUrl` to pick a grant, and
 * treats its absence as a client-credentials (`prepareTokenRequest`) provider,
 * which skips the stored-token and refresh-token branches of `auth()` entirely.
 */
export const mcpRedirectUrl = (definition: McpServerDefinition): string =>
	`http://127.0.0.1:${mcpRedirectPort(definition)}${MCP_REDIRECT_PATH}`;

/** The adapter's prefixed tool name, kept identical so the read-only policy keys still match. */
export const prefixedToolName = (serverName: string, toolName: string): string =>
	`mcp_${serverName.replace(/-/g, "_")}_${toolName}`;

const globToRegExp = (pattern: string): RegExp => {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^${escaped.replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
};

/** A selector matches the bare tool name or its prefixed name, literally or as a glob. */
export const matchesToolSelector = (serverName: string, toolName: string, selectors: string[]): boolean => {
	const candidates = [toolName, prefixedToolName(serverName, toolName)];
	return selectors.some((selector) => {
		const trimmed = selector.trim();
		if (trimmed.length === 0) return false;
		if (candidates.includes(trimmed)) return true;
		if (!/[*?]/.test(trimmed)) return false;
		const pattern = globToRegExp(trimmed);
		return candidates.some((candidate) => pattern.test(candidate));
	});
};

/** `includeTools` is an allowlist when present; `excludeTools` always subtracts. */
export const isToolAllowed = (definition: McpServerDefinition, toolName: string): boolean => {
	const include = definition.includeTools;
	if (include && include.length > 0 && !matchesToolSelector(definition.name, toolName, include)) return false;
	const exclude = definition.excludeTools;
	if (exclude && exclude.length > 0 && matchesToolSelector(definition.name, toolName, exclude)) return false;
	return true;
};
