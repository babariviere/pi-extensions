/**
 * The `/mcp-auth` browser leg.
 *
 * This is the only module that may open a consent screen, and it is only
 * reachable from the slash command, so "the user authorizes, never the tool"
 * holds structurally rather than by convention (see `oauth-provider.ts`).
 *
 * The flow is the standard loopback dance, in two `auth()` legs: the first runs
 * discovery, registers a client if needed, and hands us an authorization URL;
 * the second redeems the code the browser drops on our local callback. The
 * redirect port is fixed (not ephemeral) so a dynamically registered client
 * stays valid across runs; a client registered against a DIFFERENT redirect URI
 * is dropped up front, because the authorization server would reject it.
 */

import { spawn } from "node:child_process";
import http from "node:http";

import { auth as sdkAuth } from "@modelcontextprotocol/client";

import { McpOAuthProvider } from "./oauth-provider.ts";
import {
	loadMcpServerConfig,
	MCP_REDIRECT_PATH,
	mcpRedirectPort,
	type McpServerConfig,
	type McpServerDefinition,
	usesOAuth,
} from "./server-config.ts";
import { defaultMcpKeyring, McpTokenStore } from "./token-store.ts";

const DEFAULT_AUTH_TIMEOUT_MS = 5 * 60_000;

export interface McpOAuthCallback {
	code?: string;
	state?: string;
	/** RFC 9207 issuer identifier, passed through to the SDK's mix-up defense. */
	iss?: string;
	error?: string;
	errorDescription?: string;
}

export const parseOAuthCallback = (rawUrl: string): McpOAuthCallback => {
	const query = new URL(rawUrl, "http://127.0.0.1").searchParams;
	const callback: McpOAuthCallback = {};
	for (const [key, target] of [
		["code", "code"],
		["state", "state"],
		["iss", "iss"],
		["error", "error"],
		["error_description", "errorDescription"],
	] as const) {
		const value = query.get(key);
		if (value) callback[target as keyof McpOAuthCallback] = value;
	}
	return callback;
};

/** The local server that catches the redirect. Injectable so tests need no sockets. */
export interface McpCallbackServer {
	redirectUrl: string;
	wait(timeoutMs: number): Promise<McpOAuthCallback>;
	close(): Promise<void>;
}

export class McpAuthFlowError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "McpAuthFlowError";
	}
}

const BODY = (title: string, detail: string): string =>
	`<!doctype html><meta charset="utf-8"><title>${title}</title>` +
	`<body style="font-family:system-ui;padding:3rem;max-width:32rem">` +
	`<h1 style="font-size:1.1rem">${title}</h1><p>${detail}</p></body>`;

export const listenForOAuthCallback = async (port: number): Promise<McpCallbackServer> => {
	let settle: ((callback: McpOAuthCallback) => void) | undefined;
	const received = new Promise<McpOAuthCallback>((resolve) => {
		settle = resolve;
	});

	const server = http.createServer((request, response) => {
		const callback = parseOAuthCallback(request.url ?? "/");
		const ok = typeof callback.code === "string";
		response.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
		response.end(
			ok
				? BODY("Authorized", "You can close this tab and return to Pi.")
				: BODY(
						"Authorization failed",
						callback.errorDescription ?? callback.error ?? "No authorization code was returned.",
					),
		);
		settle?.(callback);
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", (error: NodeJS.ErrnoException) => {
			reject(
				error.code === "EADDRINUSE"
					? new McpAuthFlowError(
							`Port ${port} is already in use, so the OAuth callback cannot be received. Free it, or set oauth.redirectPort for this server in mcp.json.`,
							{ cause: error },
						)
					: error,
			);
		});
		server.listen(port, "127.0.0.1", resolve);
	});

	const close = async (): Promise<void> => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	};

	return {
		redirectUrl: `http://127.0.0.1:${port}${MCP_REDIRECT_PATH}`,
		async wait(timeoutMs) {
			let timer: NodeJS.Timeout | undefined;
			try {
				return await Promise.race([
					received,
					new Promise<McpOAuthCallback>((_resolve, reject) => {
						timer = setTimeout(
							() =>
								reject(
									new McpAuthFlowError(
										`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the authorization callback.`,
									),
								),
							timeoutMs,
						);
						timer.unref?.();
					}),
				]);
			} finally {
				if (timer) clearTimeout(timer);
			}
		},
		close,
	};
};

/**
 * Best effort. `onFailure` receives the URL back when the launcher never
 * started, which is the only case where the caller has to print it: an
 * authorization URL is 500+ characters and the UI renders a notification as a
 * single line attached to the editor, so printing it unconditionally floods the
 * prompt.
 */
export const openInBrowser = (url: URL, onFailure?: (url: URL) => void): void => {
	const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
	const args = process.platform === "win32" ? ["/c", "start", "", url.toString()] : [url.toString()];
	try {
		const child = spawn(command, args, { stdio: "ignore", detached: true });
		child.on("error", () => onFailure?.(url));
		child.unref();
	} catch {
		onFailure?.(url);
	}
};

export interface AuthorizeMcpServerOptions {
	cwd: string;
	serverName: string;
	store?: McpTokenStore;
	loadConfig?: (cwd: string) => McpServerConfig;
	/** Progress and the authorization URL, for the command's UI. */
	notify?: (message: string) => void;
	openUrl?: (url: URL, onFailure?: (url: URL) => void) => void;
	listen?: (port: number) => Promise<McpCallbackServer>;
	runAuth?: typeof sdkAuth;
	timeoutMs?: number;
}

export interface AuthorizeMcpServerResult {
	server: string;
	/** `refreshed` means no consent screen was needed. */
	state: "authorized" | "refreshed";
	redirectUrl: string;
}

const definitionFor = (config: McpServerConfig, serverName: string): McpServerDefinition => {
	const definition = config.servers.find((candidate) => candidate.name === serverName);
	if (!definition) {
		const names = config.servers.map((candidate) => candidate.name);
		throw new McpAuthFlowError(
			names.length === 0
				? "No MCP server is configured in mcp.json."
				: `Unknown MCP server '${serverName}'. Configured: ${names.join(", ")}.`,
		);
	}
	if (definition.transport !== "http") {
		throw new McpAuthFlowError(`MCP server '${serverName}' is not an HTTP server, so it has no OAuth flow.`);
	}
	if (!usesOAuth(definition)) {
		throw new McpAuthFlowError(
			`MCP server '${serverName}' does not use OAuth (a static token or custom headers are configured), so there is nothing to authorize.`,
		);
	}
	return definition;
};

/**
 * A client registered against another redirect URI cannot be reused: the
 * authorization server matches `redirect_uri` exactly and would reject it. Drop
 * it so the next leg registers a fresh one, and keep the tokens (a refresh may
 * still work).
 */
const dropMismatchedClient = (store: McpTokenStore, serverName: string, redirectUrl: string): boolean => {
	const entry = store.read(serverName);
	const registered = entry?.clientInfo?.redirectUris;
	if (!registered || registered.length === 0 || registered.includes(redirectUrl)) return false;
	const { clientInfo: _dropped, ...rest } = entry ?? {};
	store.write(serverName, rest);
	return true;
};

export const authorizeMcpServer = async (options: AuthorizeMcpServerOptions): Promise<AuthorizeMcpServerResult> => {
	const notify = options.notify ?? (() => {});
	const store = options.store ?? new McpTokenStore(defaultMcpKeyring());
	const config = (options.loadConfig ?? loadMcpServerConfig)(options.cwd);
	const definition = definitionFor(config, options.serverName);
	const serverUrl = String(definition.url);
	const listen = options.listen ?? listenForOAuthCallback;
	const runAuth = options.runAuth ?? sdkAuth;
	const timeoutMs = options.timeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;

	const server = await listen(mcpRedirectPort(definition));
	try {
		if (dropMismatchedClient(store, options.serverName, server.redirectUrl)) {
			notify(`Registered client used a different redirect URI; registering a new one for ${server.redirectUrl}.`);
		}
		const oauthConfig = definition.oauth === false || definition.oauth === undefined ? undefined : definition.oauth;
		const provider = new McpOAuthProvider({
			serverName: options.serverName,
			serverUrl,
			store,
			redirectUrl: server.redirectUrl,
			...(oauthConfig ? { config: oauthConfig } : {}),
			onRedirect: (authorizationUrl) => {
				// Short by design: the URL only shows up when the browser never opened.
				notify(`Opening the consent screen for '${options.serverName}' in your browser.`);
				(options.openUrl ?? openInBrowser)(authorizationUrl, (url) => {
					notify(
						`Could not open a browser. Open this URL to authorize '${options.serverName}':\n${url.toString()}`,
					);
				});
			},
		});

		const first = await runAuth(provider, { serverUrl });
		if (first === "AUTHORIZED") {
			return { server: options.serverName, state: "refreshed", redirectUrl: server.redirectUrl };
		}

		const callback = await server.wait(timeoutMs);
		if (callback.error) {
			throw new McpAuthFlowError(
				`The authorization server refused: ${callback.error}${callback.errorDescription ? ` (${callback.errorDescription})` : ""}.`,
			);
		}
		if (!callback.code) throw new McpAuthFlowError("The authorization callback carried no code.");
		// CSRF: the state we recorded before redirecting must come back unchanged.
		const expected = store.read(options.serverName)?.oauthState;
		if (expected && callback.state !== expected) {
			throw new McpAuthFlowError(
				"The authorization callback carried the wrong state parameter; the flow was not completed.",
			);
		}

		const second = await runAuth(provider, {
			serverUrl,
			authorizationCode: callback.code,
			...(callback.iss ? { iss: callback.iss } : {}),
		});
		if (second !== "AUTHORIZED") {
			throw new McpAuthFlowError("The authorization code was not exchanged for a token.");
		}
		return { server: options.serverName, state: "authorized", redirectUrl: server.redirectUrl };
	} finally {
		await server.close();
	}
};

/** Forget every credential for one server, so the next authorization starts clean. */
export const logoutMcpServer = (serverName: string, store?: McpTokenStore): void => {
	(store ?? new McpTokenStore(defaultMcpKeyring())).clear(serverName);
};
