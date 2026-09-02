/**
 * On-disk tool metadata for the Spindle MCP client.
 *
 * Exists so metadata reads (`mcp.list`, `mcp.search`, `mcp.describe`) never
 * force a connect. The bridge to pi-mcp-adapter could not do this: the gateway
 * re-resolved metadata per call and connecting could trigger an OAuth prompt,
 * so Spindle was limited to stub descriptors. With schemas on disk, discovery
 * is free, works offline, and cannot provoke a credential prompt.
 *
 * The cache is keyed by server name and validated against the endpoint it was
 * captured from plus the config fingerprint, so re-pointing a server or editing
 * `mcp.json` invalidates it rather than serving stale schemas.
 */

import fs from "node:fs";
import path from "node:path";

import { mcpAgentDir } from "./server-config.ts";

export interface CachedMcpTool {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
	outputSchema?: Record<string, unknown>;
	annotations?: Record<string, unknown>;
}

export interface CachedMcpServer {
	/** Endpoint the tools were captured from; a change invalidates the entry. */
	target: string;
	fingerprint: string;
	storedAt: number;
	tools: CachedMcpTool[];
}

interface CacheDocument {
	version: 1;
	servers: Record<string, CachedMcpServer>;
}

const EMPTY: CacheDocument = { version: 1, servers: {} };

export const defaultMcpToolCachePath = (): string => path.join(mcpAgentDir(), "spindle-mcp-tools.json");

export interface McpToolCacheOptions {
	filePath?: string;
	readFile?: (filePath: string) => string;
	writeFile?: (filePath: string, contents: string) => void;
	now?: () => number;
}

export class McpToolCache {
	readonly #filePath: string;
	readonly #readFile: (filePath: string) => string;
	readonly #writeFile: (filePath: string, contents: string) => void;
	readonly #now: () => number;
	#document: CacheDocument | undefined;

	constructor(options: McpToolCacheOptions = {}) {
		this.#filePath = options.filePath ?? defaultMcpToolCachePath();
		this.#readFile = options.readFile ?? ((filePath) => fs.readFileSync(filePath, "utf8"));
		this.#writeFile =
			options.writeFile ??
			((filePath, contents) => {
				fs.mkdirSync(path.dirname(filePath), { recursive: true });
				fs.writeFileSync(filePath, contents, { mode: 0o600 });
			});
		this.#now = options.now ?? Date.now;
	}

	#load(): CacheDocument {
		if (this.#document) return this.#document;
		try {
			const parsed: unknown = JSON.parse(this.#readFile(this.#filePath));
			if (
				typeof parsed === "object" &&
				parsed !== null &&
				(parsed as CacheDocument).version === 1 &&
				typeof (parsed as CacheDocument).servers === "object"
			) {
				this.#document = { version: 1, servers: { ...(parsed as CacheDocument).servers } };
				return this.#document;
			}
		} catch {
			// A missing or corrupt cache is not an error: it only costs a connect.
		}
		this.#document = { ...EMPTY, servers: {} };
		return this.#document;
	}

	#persist(): void {
		try {
			this.#writeFile(this.#filePath, JSON.stringify(this.#load(), null, "\t"));
		} catch {
			// Metadata caching is an optimization; a read-only home directory must not
			// break MCP calls.
		}
	}

	/** The cached tools for a server, or undefined when absent or invalidated. */
	get(serverName: string, target: string, fingerprint: string): CachedMcpServer | undefined {
		const entry = this.#load().servers[serverName];
		if (!entry) return undefined;
		if (entry.target !== target || entry.fingerprint !== fingerprint) return undefined;
		return entry;
	}

	/** Every cached server, unvalidated; used by search over servers that are not connected. */
	entries(): [string, CachedMcpServer][] {
		return Object.entries(this.#load().servers);
	}

	set(serverName: string, target: string, fingerprint: string, tools: CachedMcpTool[]): CachedMcpServer {
		const entry: CachedMcpServer = { target, fingerprint, storedAt: this.#now(), tools };
		this.#load().servers[serverName] = entry;
		this.#persist();
		return entry;
	}

	delete(serverName: string): void {
		if (this.#load().servers[serverName] === undefined) return;
		delete this.#load().servers[serverName];
		this.#persist();
	}
}
