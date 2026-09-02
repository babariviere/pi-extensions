import assert from "node:assert/strict";
import { test } from "node:test";

import { McpAuthorizationRequiredError, McpOAuthProvider, type McpOAuthProviderOptions } from "./oauth-provider.ts";
import { McpTokenStore, memoryKeyring } from "./token-store.ts";

const providerWith = (overrides: Partial<Omit<McpOAuthProviderOptions, "store">> = {}) => {
	const store = new McpTokenStore(memoryKeyring());
	const provider = new McpOAuthProvider({
		serverName: "slack",
		serverUrl: "https://mcp.slack.com/mcp",
		store,
		now: () => 1_000_000,
		...overrides,
	});
	return { provider, store };
};

test("tokens saved by the SDK land in the adapter's camelCase shape", () => {
	const { provider, store } = providerWith();
	provider.saveTokens({ access_token: "at", refresh_token: "rt", expires_in: 3600, token_type: "Bearer" } as never);
	assert.deepEqual(store.read("slack"), {
		tokens: { accessToken: "at", refreshToken: "rt", expiresAt: 1000 + 3600 },
		serverUrl: "https://mcp.slack.com/mcp",
	});
});

test("a stored record is handed back as an OAuth wire payload", () => {
	const { provider, store } = providerWith();
	store.write("slack", {
		tokens: { accessToken: "at", refreshToken: "rt", expiresAt: 1000 + 60 },
		serverUrl: "https://mcp.slack.com/mcp",
	});
	assert.deepEqual(provider.tokens(), {
		access_token: "at",
		token_type: "Bearer",
		refresh_token: "rt",
		expires_in: 60,
	});
});

test("an expired record reports expires_in 0 so the SDK refreshes", () => {
	const { provider, store } = providerWith();
	store.write("slack", { tokens: { accessToken: "at", expiresAt: 500 }, serverUrl: "https://mcp.slack.com/mcp" });
	assert.equal((provider.tokens() as { expires_in: number }).expires_in, 0);
});

test("a refresh response without a refresh token keeps the stored one", () => {
	const { provider, store } = providerWith();
	store.write("slack", { tokens: { accessToken: "old", refreshToken: "rt" }, serverUrl: "https://mcp.slack.com/mcp" });
	provider.saveTokens({ access_token: "new", token_type: "Bearer" } as never);
	assert.equal(store.read("slack")?.tokens?.refreshToken, "rt");
});

test("credentials minted for another url are not served", () => {
	const { provider, store } = providerWith();
	store.write("slack", { tokens: { accessToken: "at" }, serverUrl: "https://elsewhere/mcp" });
	assert.equal(provider.tokens(), undefined);
	assert.equal(provider.clientInformation(), undefined);
});

test("a rebound url replaces the record rather than merging into it", () => {
	const { provider, store } = providerWith();
	store.write("slack", {
		tokens: { accessToken: "stale" },
		clientInfo: { clientId: "old" },
		serverUrl: "https://elsewhere/mcp",
	});
	provider.saveTokens({ access_token: "fresh", token_type: "Bearer" } as never);
	assert.deepEqual(store.read("slack"), {
		tokens: { accessToken: "fresh" },
		serverUrl: "https://mcp.slack.com/mcp",
	});
});

test("a config clientId wins over a dynamically registered one", () => {
	const { provider, store } = providerWith({ config: { clientId: "configured" } });
	store.write("slack", { clientInfo: { clientId: "registered" }, serverUrl: "https://mcp.slack.com/mcp" });
	assert.deepEqual(provider.clientInformation(), { client_id: "configured" });
});

test("dynamic registration round-trips through the store", () => {
	const { provider } = providerWith();
	provider.saveClientInformation({
		client_id: "cid",
		client_secret: "sec",
		redirect_uris: ["http://127.0.0.1:1/cb"],
	} as never);
	assert.deepEqual(provider.clientInformation(), { client_id: "cid", client_secret: "sec" });
});

test("client metadata advertises the loopback redirect and requested scopes", () => {
	const { provider } = providerWith({
		config: { scopes: ["read", "write"] },
		redirectUrl: "http://127.0.0.1:7777/callback",
	});
	const metadata = provider.clientMetadata as unknown as Record<string, unknown>;
	assert.deepEqual(metadata.redirect_uris, ["http://127.0.0.1:7777/callback"]);
	assert.equal(metadata.scope, "read write");
	assert.equal(metadata.token_endpoint_auth_method, "none");
});

test("a browser flow is refused without onRedirect, and the refusal names /mcp-auth", async () => {
	const { provider } = providerWith();
	await assert.rejects(
		() => provider.redirectToAuthorization(new URL("https://auth.example/authorize")),
		McpAuthorizationRequiredError,
	);
	await assert.rejects(
		() => provider.redirectToAuthorization(new URL("https://auth.example/authorize")),
		/ask the user to run '\/mcp-auth slack'/,
	);
	assert.throws(() => provider.codeVerifier(), McpAuthorizationRequiredError);
});

test("onRedirect is the only way to reach a consent screen", async () => {
	const seen: string[] = [];
	const { provider } = providerWith({ onRedirect: (url) => void seen.push(url.toString()) });
	await provider.redirectToAuthorization(new URL("https://auth.example/authorize?x=1"));
	assert.deepEqual(seen, ["https://auth.example/authorize?x=1"]);
});

test("the PKCE verifier and state persist for the callback leg", () => {
	const { provider, store } = providerWith();
	provider.saveCodeVerifier("verifier");
	const state = provider.state();
	assert.equal(provider.codeVerifier(), "verifier");
	assert.equal(store.read("slack")?.oauthState, state);
});
