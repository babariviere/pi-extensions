import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentRole } from "../../types.ts";

export const CONTEXT_MANIFEST_VERSION = 1 as const;
export const DEFAULT_CONTEXT_MAX_BYTES = 64 * 1024;

export interface ContextManifestInput {
	attemptId: string;
	caseId: string;
	role: AgentRole;
	context: Record<string, unknown>;
	createdAt?: string;
}

export interface ContextManifest extends ContextManifestInput {
	version: 1;
	createdAt: string;
	truncated: boolean;
}

export interface ContextArtifactWriter {
	createArtifact(input: {
		id?: string;
		caseId?: string;
		attemptId?: string;
		kind: string;
		path: string;
		hash?: string;
		metadata?: unknown;
	}): string;
}

function bounded(value: unknown, budget: number, depth: number): unknown {
	if (budget <= 0 || depth > 6) return "[truncated]";
	if (typeof value === "string")
		return value.length > budget ? `${value.slice(0, Math.max(0, budget - 14))}…[truncated]` : value;
	if (value === null || typeof value === "number" || typeof value === "boolean") return value;
	if (Array.isArray(value)) {
		const result: unknown[] = [];
		for (const item of value.slice(0, 32)) result.push(bounded(item, Math.floor(budget / 2), depth + 1));
		if (value.length > result.length) result.push(`[${value.length - result.length} items truncated]`);
		return result;
	}
	if (typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort().slice(0, 64)) {
			result[key] = bounded((value as Record<string, unknown>)[key], Math.floor(budget / 2), depth + 1);
		}
		return result;
	}
	return `[unsupported ${typeof value}]`;
}

function encoded(manifest: ContextManifest): string {
	return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function buildContextManifest(
	input: ContextManifestInput,
	options: { maxBytes?: number; now?: Date } = {},
): ContextManifest {
	const maxBytes = options.maxBytes ?? DEFAULT_CONTEXT_MAX_BYTES;
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 256) throw new Error("maxBytes must be at least 256");
	const createdAt = input.createdAt ?? (options.now ?? new Date()).toISOString();
	if (Number.isNaN(new Date(createdAt).getTime())) throw new Error("createdAt must be a valid timestamp");
	const inputWasLarge = Buffer.byteLength(JSON.stringify(input.context), "utf8") > maxBytes;
	let context = bounded(input.context, maxBytes, 0) as Record<string, unknown>;
	let manifest: ContextManifest = {
		version: 1,
		attemptId: input.attemptId,
		caseId: input.caseId,
		role: input.role,
		createdAt,
		truncated: inputWasLarge,
		context,
	};
	while (Buffer.byteLength(encoded(manifest), "utf8") > maxBytes) {
		manifest = {
			...manifest,
			context: { truncated: true, summary: "Context exceeded the configured manifest budget" },
			truncated: true,
		};
		if (Buffer.byteLength(encoded(manifest), "utf8") <= maxBytes) break;
		const compact = JSON.stringify({
			version: 1,
			attemptId: input.attemptId,
			caseId: input.caseId,
			role: input.role,
			createdAt,
			truncated: true,
			context: {},
		});
		if (Buffer.byteLength(compact, "utf8") > maxBytes) throw new Error("context manifest metadata exceeds maxBytes");
		manifest = JSON.parse(compact) as ContextManifest;
	}
	return manifest;
}

/** Persist atomically before a process is launched, and record the durable artifact. */
export function persistContextManifest(
	manifest: ContextManifest,
	options: { attemptDirectory: string; database?: ContextArtifactWriter },
): { path: string; hash: string; artifactId?: string } {
	const directory = options.attemptDirectory;
	if (!directory.startsWith("/")) throw new Error("attemptDirectory must be absolute");
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const path = join(directory, "context-manifest.json");
	const temporary = `${path}.${randomUUID()}.tmp`;
	const content = encoded(manifest);
	const hash = createHash("sha256").update(content).digest("hex");
	writeFileSync(temporary, content, { mode: 0o600 });
	chmodSync(temporary, 0o600);
	renameSync(temporary, path);
	chmodSync(path, 0o600);
	const artifactId = options.database?.createArtifact({
		caseId: manifest.caseId,
		attemptId: manifest.attemptId,
		kind: "context-manifest",
		path,
		hash,
		metadata: { version: manifest.version, role: manifest.role, truncated: manifest.truncated },
	});
	return { path, hash, ...(artifactId ? { artifactId } : {}) };
}

export const createContextManifest = buildContextManifest;
export const persistContextArtifact = persistContextManifest;
