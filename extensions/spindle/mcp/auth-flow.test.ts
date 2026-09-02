import assert from "node:assert/strict";
import { test } from "node:test";

import {
	authorizeMcpServer,
	logoutMcpServer,
	McpAuthFlowError,
	type McpCallbackServer,
	parseOAuthCallback,
} from "./auth-flow.ts";
import type { McpServerConfig, McpServerDefinition } from "./server-config.ts";
import { McpTokenStore, memoryKeyring } from "./token-store.ts";

const server = (overrides: Partial<McpServerDefinition> = {}): McpServerDefinition => ({
	name: "slack",
	transport: "http",
	url: "https://mcp.slack.com/mcp",
	disabled: false,
	sources: [],
	...overrides,
});

const config = (...servers: McpServerDefinition[]): McpServerConfig => ({ servers, layers: [], errors: [] });

const fakeListen = (callback: Partial<Parameters<McpCallbackServer["wait"]> extends never ? never : object> = {}) => {
	const closed: boolean[] = [];
	const listen = async (port: number): Promise<McpCallbackServer> => ({
		redirectUrl: `http://127.0.0.1:${port}/callback`,
		wait: async () => callback as never,
		close: async () => void closed.push(true),
	});
	return { listen, closed };
};

test("a callback query is parsed into code, state and issuer", () => {
	assert.deepEqual(parseOAuthCallback("/callback?code=abc&state=xyz&iss=https%3A%2F%2Fauth.example"), {
		code: "abc",
		state: "xyz",
		iss: "https://auth.example",
	});
	assert.deepEqual(parseOAuthCallback("/callback?error=access_denied&error_description=nope"), {
		error: "access_denied",
		errorDescription: "nope",
	});
	assert.deepEqual(parseOAuthCallback("/callback"), {});
});

test("an unknown server names the configured ones", async () => {
	await assert.rejects(
		() =>
			authorizeMcpServer({
				cwd: "/repo",
				serverName: "nope",
				store: new McpTokenStore(memoryKeyring()),
				loadConfig: () => config(server()),
			}),
		/Unknown MCP server 'nope'. Configured: slack/,
	);
});

test("a server with a static token has nothing to authorize", async () => {
	await assert.rejects(
		() =>
			authorizeMcpServer({
				cwd: "/repo",
				serverName: "slack",
				store: new McpTokenStore(memoryKeyring()),
				loadConfig: () => config(server({ bearerToken: "t" })),
			}),
		/does not use OAuth/,
	);
});

test("a headless refresh reports refreshed and never waits for a browser", async () => {
	const { listen, closed } = fakeListen();
	const result = await authorizeMcpServer({
		cwd: "/repo",
		serverName: "slack",
		store: new McpTokenStore(memoryKeyring()),
		loadConfig: () => config(server()),
		listen,
		runAuth: async () => "AUTHORIZED",
	});
	assert.deepEqual(result, {
		server: "slack",
		state: "refreshed",
		redirectUrl: "http://127.0.0.1:33418/callback",
	});
	assert.deepEqual(closed, [true]);
});

test("a consent screen leg redeems the callback code", async () => {
	const store = new McpTokenStore(memoryKeyring());
	const { listen } = fakeListen({ code: "the-code", iss: "https://auth.example" });
	const opened: string[] = [];
	const notes: string[] = [];
	const seen: unknown[] = [];
	const result = await authorizeMcpServer({
		cwd: "/repo",
		serverName: "slack",
		store,
		loadConfig: () => config(server()),
		listen,
		notify: (message) => void notes.push(message),
		openUrl: (url) => void opened.push(url.toString()),
		runAuth: async (provider, authOptions) => {
			seen.push(authOptions);
			if (!authOptions.authorizationCode) {
				await provider.redirectToAuthorization(new URL("https://auth.example/authorize?x=1"));
				return "REDIRECT";
			}
			return "AUTHORIZED";
		},
	});
	assert.equal(result.state, "authorized");
	assert.deepEqual(opened, ["https://auth.example/authorize?x=1"]);
	assert.match(String(notes[0]), /Opening the consent screen for 'slack'/);
	assert.deepEqual(seen[1], {
		serverUrl: "https://mcp.slack.com/mcp",
		authorizationCode: "the-code",
		iss: "https://auth.example",
	});
});

test("a callback with the wrong state is refused", async () => {
	const store = new McpTokenStore(memoryKeyring());
	const { listen } = fakeListen({ code: "the-code", state: "forged" });
	await assert.rejects(
		() =>
			authorizeMcpServer({
				cwd: "/repo",
				serverName: "slack",
				store,
				loadConfig: () => config(server()),
				listen,
				runAuth: async (provider, authOptions) => {
					if (!authOptions.authorizationCode) {
						// The SDK records state before redirecting; so do we.
						provider.state?.();
						return "REDIRECT";
					}
					return "AUTHORIZED";
				},
			}),
		/wrong state parameter/,
	);
});

test("an authorization-server error is surfaced verbatim", async () => {
	const { listen } = fakeListen({ error: "access_denied", errorDescription: "user said no" });
	await assert.rejects(
		() =>
			authorizeMcpServer({
				cwd: "/repo",
				serverName: "slack",
				store: new McpTokenStore(memoryKeyring()),
				loadConfig: () => config(server()),
				listen,
				runAuth: async () => "REDIRECT",
			}),
		/access_denied \(user said no\)/,
	);
});

test("a client registered against another redirect URI is dropped, tokens kept", async () => {
	const store = new McpTokenStore(memoryKeyring());
	store.write("slack", {
		clientInfo: { clientId: "old", redirectUris: ["http://127.0.0.1:9999/callback"] },
		tokens: { accessToken: "keep-me" },
		serverUrl: "https://mcp.slack.com/mcp",
	});
	const { listen } = fakeListen();
	const notes: string[] = [];
	await authorizeMcpServer({
		cwd: "/repo",
		serverName: "slack",
		store,
		loadConfig: () => config(server()),
		listen,
		notify: (message) => void notes.push(message),
		runAuth: async () => "AUTHORIZED",
	});
	const entry = store.read("slack");
	assert.equal(entry?.clientInfo, undefined);
	assert.equal(entry?.tokens?.accessToken, "keep-me");
	assert.match(String(notes[0]), /different redirect URI/);
});

test("a matching registered client is kept", async () => {
	const store = new McpTokenStore(memoryKeyring());
	store.write("slack", {
		clientInfo: { clientId: "keep", redirectUris: ["http://127.0.0.1:33418/callback"] },
		serverUrl: "https://mcp.slack.com/mcp",
	});
	const { listen } = fakeListen();
	await authorizeMcpServer({
		cwd: "/repo",
		serverName: "slack",
		store,
		loadConfig: () => config(server()),
		listen,
		runAuth: async () => "AUTHORIZED",
	});
	assert.equal(store.read("slack")?.clientInfo?.clientId, "keep");
});

test("logout clears the record", () => {
	const store = new McpTokenStore(memoryKeyring());
	store.write("slack", { tokens: { accessToken: "a" } });
	logoutMcpServer("slack", store);
	assert.equal(store.read("slack"), undefined);
});

test("a configured redirectPort wins over the default", async () => {
	const { listen } = fakeListen();
	const result = await authorizeMcpServer({
		cwd: "/repo",
		serverName: "slack",
		store: new McpTokenStore(memoryKeyring()),
		loadConfig: () => config(server({ oauth: { redirectPort: 4567 } })),
		listen,
		runAuth: async () => "AUTHORIZED",
	});
	assert.equal(result.redirectUrl, "http://127.0.0.1:4567/callback");
});

test("McpAuthFlowError is used for flow failures", async () => {
	const { listen } = fakeListen({ code: undefined });
	await assert.rejects(
		() =>
			authorizeMcpServer({
				cwd: "/repo",
				serverName: "slack",
				store: new McpTokenStore(memoryKeyring()),
				loadConfig: () => config(server()),
				listen,
				runAuth: async () => "REDIRECT",
			}),
		McpAuthFlowError,
	);
});
