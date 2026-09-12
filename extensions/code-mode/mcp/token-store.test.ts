import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
	type McpAuthEntry,
	type McpKeyring,
	McpTokenStore,
	McpTokenStoreUnavailableError,
	mcpAuthAccount,
	memoryKeyring,
} from "./token-store.ts";

const countingKeyring = (entries: Map<string, string>) => {
	const reads: string[] = [];
	const keyring: McpKeyring = {
		read(account) {
			reads.push(account);
			return entries.get(account);
		},
		write(account, payload) {
			entries.set(account, payload);
		},
		remove(account) {
			entries.delete(account);
		},
	};
	return { keyring, reads };
};

const chunked = (serverName: string, entry: McpAuthEntry, chunkSize = 8): Map<string, string> => {
	const account = mcpAuthAccount(serverName);
	const payload = JSON.stringify(entry);
	const digest = createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 16);
	const chunkCount = Math.ceil(payload.length / chunkSize);
	const entries = new Map<string, string>();
	entries.set(account, JSON.stringify({ __piMcpAdapterOAuthChunked: 1, chunkCount, chunkDigest: digest }));
	for (let index = 0; index < chunkCount; index++) {
		entries.set(`${account}.chunk.${digest}.${index}`, payload.slice(index * chunkSize, (index + 1) * chunkSize));
	}
	return entries;
};

test("the account is the adapter's server-name hash, so entries interoperate", () => {
	assert.equal(mcpAuthAccount("slack"), `sha256-${createHash("sha256").update("slack", "utf8").digest("hex")}`);
});

test("a single-item record round-trips", () => {
	const store = new McpTokenStore(memoryKeyring());
	store.write("slack", { tokens: { accessToken: "a", refreshToken: "r" }, serverUrl: "https://mcp.slack.com/mcp" });
	assert.deepEqual(store.read("slack"), {
		tokens: { accessToken: "a", refreshToken: "r" },
		serverUrl: "https://mcp.slack.com/mcp",
	});
});

test("a chunked adapter record is read and compacted to one item", () => {
	const entry: McpAuthEntry = { tokens: { accessToken: "long-access-token-value", refreshToken: "long-refresh" } };
	const entries = chunked("slack", entry);
	const account = mcpAuthAccount("slack");
	assert.ok(entries.size > 1, "fixture should be chunked");
	const store = new McpTokenStore(memoryKeyring(entries));
	assert.deepEqual(store.read("slack"), entry);
	assert.equal(store.compactions, 1);
	assert.deepEqual([...entries.keys()], [account]);
	// The compacted payload is still what the adapter's non-manifest read path expects.
	assert.deepEqual(JSON.parse(entries.get(account) ?? "null"), entry);
});

test("a compacted record costs one credential-store read, not one per chunk", () => {
	const entries = chunked("slack", { tokens: { accessToken: "another-long-access-token" } });
	const { keyring, reads } = countingKeyring(entries);
	const store = new McpTokenStore(keyring);
	store.read("slack");
	const chunkedReads = reads.length;
	reads.length = 0;
	store.read("slack");
	assert.equal(reads.length, 1);
	assert.ok(chunkedReads > reads.length, "the chunked read should have cost more than the compacted one");
});

test("a write clears the chunk items left by the adapter", () => {
	const entries = chunked("slack", { tokens: { accessToken: "stale-access-token-value" } });
	const store = new McpTokenStore(memoryKeyring(entries));
	store.write("slack", { tokens: { accessToken: "fresh" } });
	assert.deepEqual([...entries.keys()], [mcpAuthAccount("slack")]);
});

test("a missing chunk reads as absent instead of throwing", () => {
	const entries = chunked("slack", { tokens: { accessToken: "a-token-long-enough-to-chunk" } });
	const account = mcpAuthAccount("slack");
	const chunkKey = [...entries.keys()].find((key) => key !== account);
	entries.delete(String(chunkKey));
	const store = new McpTokenStore(memoryKeyring(entries));
	assert.equal(store.read("slack"), undefined);
});

test("update merges into the stored record", () => {
	const store = new McpTokenStore(memoryKeyring());
	store.write("slack", { clientInfo: { clientId: "cid" } });
	store.update("slack", (entry) => ({ ...entry, tokens: { accessToken: "a" } }));
	assert.deepEqual(store.read("slack"), { clientInfo: { clientId: "cid" }, tokens: { accessToken: "a" } });
});

test("clear removes the record and its stale chunks", () => {
	const entries = chunked("slack", { tokens: { accessToken: "a-token-long-enough-to-chunk" } });
	const store = new McpTokenStore(memoryKeyring(entries));
	store.clear("slack");
	assert.equal(entries.size, 0);
});

test("an unavailable credential store surfaces an actionable error", () => {
	const store = new McpTokenStore({
		read() {
			throw new Error("locked");
		},
		write() {
			throw new Error("locked");
		},
		remove() {
			throw new Error("locked");
		},
	});
	assert.throws(() => store.read("slack"), McpTokenStoreUnavailableError);
	assert.throws(() => store.write("slack", {}), McpTokenStoreUnavailableError);
});
