/**
 * OAuth credential storage for the Spindle MCP client.
 *
 * Deliberately interoperable with pi-mcp-adapter: same OS credential-store
 * service, same `sha256-<sha256(serverName)>` account, same camelCase entry
 * payload. Switching clients therefore needs no re-authentication, and either
 * client can read what the other wrote.
 *
 * One difference, and it is the point of this file: a record is always written
 * as a SINGLE credential-store item. The adapter chunks any payload over 1280
 * chars into 1000-char items to respect the Windows Credential Manager blob
 * cap, which on macOS turns one server into six keychain items, each with its
 * own ACL and therefore its own "allow" prompt. Reading a chunked record here
 * transparently compacts it back to one item (`read()` rewrites, then deletes
 * the chunk items), so the prompt storm dies on first use and the record stays
 * readable by the adapter, whose read path already sniffs manifest vs payload.
 */

import { createHash } from "node:crypto";
import { createRequire } from "node:module";

export const MCP_AUTH_SERVICE = "pi-mcp-adapter.oauth";
const CHUNK_MANIFEST_KEY = "__piMcpAdapterOAuthChunked";

export interface McpStoredTokens {
	accessToken: string;
	refreshToken?: string;
	/** Unix seconds, matching the adapter's on-disk shape. */
	expiresAt?: number;
	scope?: string;
	issuer?: string;
}

export interface McpStoredClientInfo {
	clientId: string;
	clientSecret?: string;
	clientIdIssuedAt?: number;
	clientSecretExpiresAt?: number;
	redirectUris?: string[];
	issuer?: string;
}

export interface McpAuthEntry {
	tokens?: McpStoredTokens;
	clientInfo?: McpStoredClientInfo;
	codeVerifier?: string;
	oauthState?: string;
	/** URL the credentials were minted for; a mismatch invalidates them. */
	serverUrl?: string;
}

/** The three operations this store needs from an OS credential store. */
export interface McpKeyring {
	read(account: string): string | undefined;
	write(account: string, payload: string): void;
	remove(account: string): void;
}

export class McpTokenStoreUnavailableError extends Error {
	constructor(
		readonly operation: "read" | "write" | "remove",
		cause: unknown,
	) {
		super(
			`The OS credential store is unavailable (${operation}). Unlock the keychain, or set SPINDLE_MCP_TOKEN_STORE=memory to run without persisted MCP credentials.`,
			{ cause },
		);
		this.name = "McpTokenStoreUnavailableError";
	}
}

export const mcpAuthAccount = (serverName: string): string =>
	`sha256-${createHash("sha256").update(serverName, "utf8").digest("hex")}`;

interface ChunkManifest {
	chunkCount: number;
	chunkDigest: string;
}

const readChunkManifest = (payload: string): ChunkManifest | undefined => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(payload);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const record = parsed as Record<string, unknown>;
	if (record[CHUNK_MANIFEST_KEY] !== 1) return undefined;
	const chunkCount = record.chunkCount;
	const chunkDigest = record.chunkDigest;
	if (typeof chunkCount !== "number" || !Number.isInteger(chunkCount) || chunkCount <= 0) return undefined;
	if (typeof chunkDigest !== "string" || !/^[a-f0-9]{16}$/.test(chunkDigest)) return undefined;
	return { chunkCount, chunkDigest };
};

const chunkAccounts = (account: string, manifest: ChunkManifest): string[] =>
	Array.from({ length: manifest.chunkCount }, (_, index) => `${account}.chunk.${manifest.chunkDigest}.${index}`);

const asEntry = (payload: string): McpAuthEntry | undefined => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(payload);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
	return parsed as McpAuthEntry;
};

export class McpTokenStore {
	/** Chunked records collapsed into a single item, for the test that proves it happens. */
	#compactions = 0;

	constructor(readonly keyring: McpKeyring) {}

	get compactions(): number {
		return this.#compactions;
	}

	read(serverName: string): McpAuthEntry | undefined {
		const account = mcpAuthAccount(serverName);
		let payload: string | undefined;
		try {
			payload = this.keyring.read(account);
		} catch (error) {
			throw new McpTokenStoreUnavailableError("read", error);
		}
		if (payload === undefined) return undefined;
		const manifest = readChunkManifest(payload);
		if (!manifest) return asEntry(payload);
		const accounts = chunkAccounts(account, manifest);
		let joined = "";
		for (const chunkAccount of accounts) {
			let chunk: string | undefined;
			try {
				chunk = this.keyring.read(chunkAccount);
			} catch (error) {
				throw new McpTokenStoreUnavailableError("read", error);
			}
			// A missing chunk means a half-written record; treat it as absent rather
			// than surfacing a parse error the caller cannot act on.
			if (chunk === undefined) return undefined;
			joined += chunk;
		}
		const entry = asEntry(joined);
		if (!entry) return undefined;
		this.#compact(account, accounts, joined);
		return entry;
	}

	/** Rewrite a chunked record as one item. Best effort: a failure must not fail the read. */
	#compact(account: string, accounts: string[], payload: string): void {
		try {
			this.keyring.write(account, payload);
			for (const chunkAccount of accounts) this.keyring.remove(chunkAccount);
			this.#compactions++;
		} catch {
			// Leave the chunked record in place; the next read retries.
		}
	}

	write(serverName: string, entry: McpAuthEntry): void {
		const account = mcpAuthAccount(serverName);
		let previousManifest: ChunkManifest | undefined;
		try {
			const existing = this.keyring.read(account);
			if (existing !== undefined) previousManifest = readChunkManifest(existing);
		} catch {
			// An unreadable previous record cannot be cleaned up; the write below still
			// decides whether the store works at all.
		}
		try {
			this.keyring.write(account, JSON.stringify(entry));
		} catch (error) {
			throw new McpTokenStoreUnavailableError("write", error);
		}
		if (!previousManifest) return;
		for (const chunkAccount of chunkAccounts(account, previousManifest)) {
			try {
				this.keyring.remove(chunkAccount);
			} catch {
				// Stale chunk cleanup must never hide a successful write.
			}
		}
	}

	/** Merge into the stored record so a token save does not drop client info. */
	update(serverName: string, patch: (entry: McpAuthEntry) => McpAuthEntry): McpAuthEntry {
		const current = this.read(serverName) ?? {};
		const next = patch({ ...current });
		this.write(serverName, next);
		return next;
	}

	clear(serverName: string): void {
		const account = mcpAuthAccount(serverName);
		let manifest: ChunkManifest | undefined;
		try {
			const existing = this.keyring.read(account);
			if (existing !== undefined) manifest = readChunkManifest(existing);
		} catch {
			// fall through to the remove below
		}
		try {
			this.keyring.remove(account);
		} catch (error) {
			throw new McpTokenStoreUnavailableError("remove", error);
		}
		if (!manifest) return;
		for (const chunkAccount of chunkAccounts(account, manifest)) {
			try {
				this.keyring.remove(chunkAccount);
			} catch {
				// best effort
			}
		}
	}
}

/** Process-local store, used when SPINDLE_MCP_TOKEN_STORE=memory. */
export const memoryKeyring = (entries = new Map<string, string>()): McpKeyring => ({
	read: (account) => entries.get(account),
	write: (account, payload) => {
		entries.set(account, payload);
	},
	remove: (account) => {
		entries.delete(account);
	},
});

interface KeyringEntry {
	getPassword(): string | null;
	setPassword(password: string): void;
	deleteCredential(): boolean;
}

type KeyringEntryConstructor = new (service: string, account: string) => KeyringEntry;

let entryClass: KeyringEntryConstructor | undefined;

const loadEntryClass = (): KeyringEntryConstructor => {
	if (entryClass) return entryClass;
	const require = createRequire(import.meta.url);
	const loaded = require("@napi-rs/keyring") as { Entry: KeyringEntryConstructor };
	entryClass = loaded.Entry;
	return entryClass;
};

/** The OS credential store, or an in-memory one when SPINDLE_MCP_TOKEN_STORE=memory. */
export const defaultMcpKeyring = (): McpKeyring => {
	if (process.env.SPINDLE_MCP_TOKEN_STORE === "memory") return memoryKeyring();
	return {
		read(account) {
			return new (loadEntryClass())(MCP_AUTH_SERVICE, account).getPassword() ?? undefined;
		},
		write(account, payload) {
			new (loadEntryClass())(MCP_AUTH_SERVICE, account).setPassword(payload);
		},
		remove(account) {
			new (loadEntryClass())(MCP_AUTH_SERVICE, account).deleteCredential();
		},
	};
};
