/**
 * ADAPTED from upstream `src/providers/mcp-descriptor-cache.ts`.
 *
 * Upstream caches its own mcporter descriptors. Spindle owns no MCP client: it
 * forwards metadata reads ($list / $search / $describe) to the pi-mcp-adapter
 * gateway, which re-resolves them on every call. Those reads are pure metadata,
 * repeat constantly inside a single program (discovery, then a call), and are
 * the only MCP surface that is safe to memoize.
 *
 * The cache is therefore in-process, short-lived, and invalidated by anything
 * that can change the answer: a config-file fingerprint (mtime + size of the
 * mcp.json layers), an explicit $connect, and a TTL.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Metadata reads are cheap to redo; a short window still kills the repeats. */
export const MCP_DESCRIPTOR_CACHE_TTL_MS = 30_000;

export const MCP_CACHEABLE_ACTIONS: ReadonlySet<string> = new Set(["$list", "$search", "$describe"]);

const configLayerPaths = (cwd: string): string[] => {
	const agentDir = process.env.PI_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
	const layers = [path.join(agentDir, "mcp.json")];
	// A degenerate context (early startup, tests) has no cwd; the project layer
	// simply drops out of the fingerprint.
	if (typeof cwd === "string" && cwd.length > 0) layers.push(path.join(cwd, ".pi", "mcp.json"));
	return layers;
};

/** mtime + size of every MCP config layer; a missing layer contributes nothing. */
export const mcpConfigFingerprint = (cwd: string): string =>
	configLayerPaths(cwd)
		.map((layerPath) => {
			try {
				const stat = fs.statSync(layerPath);
				return `${layerPath}:${stat.mtimeMs}:${stat.size}`;
			} catch {
				return `${layerPath}:absent`;
			}
		})
		.join("|");

interface CacheEntry {
	fingerprint: string;
	storedAt: number;
	value: unknown;
}

export class McpDescriptorCache {
	readonly #entries = new Map<string, CacheEntry>();

	constructor(
		readonly ttlMs: number = MCP_DESCRIPTOR_CACHE_TTL_MS,
		readonly now: () => number = Date.now,
		readonly fingerprint: (cwd: string) => string = mcpConfigFingerprint,
	) {}

	#key(actionName: string, args: Record<string, unknown>): string {
		return `${actionName}\u0000${JSON.stringify(args, Object.keys(args).sort())}`;
	}

	get(actionName: string, args: Record<string, unknown>, cwd: string): { value: unknown } | undefined {
		if (!MCP_CACHEABLE_ACTIONS.has(actionName)) return undefined;
		const entry = this.#entries.get(this.#key(actionName, args));
		if (!entry) return undefined;
		if (this.now() - entry.storedAt > this.ttlMs || entry.fingerprint !== this.fingerprint(cwd)) {
			this.#entries.delete(this.#key(actionName, args));
			return undefined;
		}
		return { value: entry.value };
	}

	set(actionName: string, args: Record<string, unknown>, cwd: string, value: unknown): void {
		if (!MCP_CACHEABLE_ACTIONS.has(actionName)) return;
		this.#entries.set(this.#key(actionName, args), {
			fingerprint: this.fingerprint(cwd),
			storedAt: this.now(),
			value,
		});
	}

	/** A connect changes what every metadata read reports. */
	clear(): void {
		this.#entries.clear();
	}

	get size(): number {
		return this.#entries.size;
	}
}
