/**
 * `OAuthClientProvider` for the Spindle MCP client, backed by
 * `McpTokenStore` (and therefore by pi-mcp-adapter's own credential-store
 * records, so no re-authentication is needed when switching clients).
 *
 * Non-interactive unless a human asked for it. A refresh-token grant runs
 * headless and is the common case for an already-authorized server. A consent
 * screen needs `onRedirect`, which ONLY `mcp/auth-flow.ts` supplies, and
 * `auth-flow.ts` is only reachable from the `/mcp-auth` command. `client-hub.ts`
 * has no way to pass it, so a tool call always gets
 * `McpAuthorizationRequiredError` instead of a browser window, and its message
 * tells the model to ask the user to run `/mcp-auth <server>`.
 *
 * Tokens are URL-bound: a record minted for one `url` is ignored (not sent)
 * when the configured url changes.
 */

import { randomUUID } from "node:crypto";

import type {
	OAuthClientInformationContext,
	OAuthClientMetadata,
	OAuthClientProvider,
	StoredOAuthClientInformation,
	StoredOAuthTokens,
} from "@modelcontextprotocol/client";

import type { McpOAuthConfig } from "./server-config.ts";
import type { McpAuthEntry, McpTokenStore } from "./token-store.ts";

export class McpAuthorizationRequiredError extends Error {
	readonly code = "MCP_AUTHORIZATION_REQUIRED";

	constructor(readonly serverName: string) {
		super(
			`MCP server '${serverName}' is not authorized. Stop and ask the user to run '/mcp-auth ${serverName}' in this session, then retry the call. ` +
				"Do not attempt to authorize it yourself: the OAuth consent screen must be opened by the user, not by a tool call.",
		);
		this.name = "McpAuthorizationRequiredError";
	}
}

export interface McpOAuthProviderOptions {
	serverName: string;
	serverUrl: string;
	store: McpTokenStore;
	config?: McpOAuthConfig;
	/** Client name advertised to the authorization server during registration. */
	clientName?: string;
	/** Loopback redirect URI; must match what the callback server listens on. */
	redirectUrl?: string;
	/**
	 * Consent-screen handler. Supplied only by `mcp/auth-flow.ts`, i.e. only when
	 * a human ran `/mcp-auth`. Absent everywhere else, which is what makes an
	 * unattended authorization impossible rather than merely discouraged.
	 */
	onRedirect?: (authorizationUrl: URL) => void | Promise<void>;
	now?: () => number;
}

const nowSeconds = (now: () => number): number => Math.floor(now() / 1000);

const asRecord = (value: unknown): Record<string, unknown> =>
	typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

const optionalString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const optionalNumber = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;

export class McpOAuthProvider implements OAuthClientProvider {
	readonly #options: McpOAuthProviderOptions;
	readonly #now: () => number;

	constructor(options: McpOAuthProviderOptions) {
		this.#options = options;
		this.#now = options.now ?? Date.now;
	}

	get redirectUrl(): string | undefined {
		return this.#options.redirectUrl;
	}

	get clientMetadata(): OAuthClientMetadata {
		const config = this.#options.config;
		const redirectUris = this.#options.redirectUrl ? [this.#options.redirectUrl] : [];
		const metadata: Record<string, unknown> = {
			client_name: this.#options.clientName ?? "pi-spindle",
			redirect_uris: redirectUris,
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: config?.clientSecret ? "client_secret_post" : "none",
		};
		if (config?.scopes && config.scopes.length > 0) metadata.scope = config.scopes.join(" ");
		return metadata as OAuthClientMetadata;
	}

	/** The stored record, or undefined when it belongs to a different url. */
	#entry(): McpAuthEntry | undefined {
		const entry = this.#options.store.read(this.#options.serverName);
		if (!entry) return undefined;
		if (entry.serverUrl !== undefined && entry.serverUrl !== this.#options.serverUrl) return undefined;
		return entry;
	}

	#save(patch: (entry: McpAuthEntry) => McpAuthEntry): void {
		this.#options.store.update(this.#options.serverName, (current) => {
			const rebound = current.serverUrl !== undefined && current.serverUrl !== this.#options.serverUrl;
			const base = rebound ? {} : current;
			return { ...patch(base), serverUrl: this.#options.serverUrl };
		});
	}

	state(): string {
		const value = randomUUID();
		this.#save((entry) => ({ ...entry, oauthState: value }));
		return value;
	}

	clientInformation(_ctx?: OAuthClientInformationContext): StoredOAuthClientInformation | undefined {
		const config = this.#options.config;
		// A pre-registered client in mcp.json wins over anything cached, so editing
		// the config takes effect without clearing credentials.
		if (config?.clientId) {
			const information: Record<string, unknown> = { client_id: config.clientId };
			if (config.clientSecret) information.client_secret = config.clientSecret;
			return information as StoredOAuthClientInformation;
		}
		const clientInfo = this.#entry()?.clientInfo;
		if (!clientInfo?.clientId) return undefined;
		const information: Record<string, unknown> = { client_id: clientInfo.clientId };
		if (clientInfo.clientSecret) information.client_secret = clientInfo.clientSecret;
		if (clientInfo.clientIdIssuedAt !== undefined) information.client_id_issued_at = clientInfo.clientIdIssuedAt;
		if (clientInfo.clientSecretExpiresAt !== undefined) {
			information.client_secret_expires_at = clientInfo.clientSecretExpiresAt;
		}
		if (clientInfo.issuer) information.issuer = clientInfo.issuer;
		return information as StoredOAuthClientInformation;
	}

	saveClientInformation(clientInformation: StoredOAuthClientInformation): void {
		const record = asRecord(clientInformation);
		const clientId = optionalString(record.client_id);
		if (!clientId) return;
		const clientInfo: McpAuthEntry["clientInfo"] = { clientId };
		const clientSecret = optionalString(record.client_secret);
		if (clientSecret) clientInfo.clientSecret = clientSecret;
		const issuedAt = optionalNumber(record.client_id_issued_at);
		if (issuedAt !== undefined) clientInfo.clientIdIssuedAt = issuedAt;
		const secretExpiresAt = optionalNumber(record.client_secret_expires_at);
		if (secretExpiresAt !== undefined) clientInfo.clientSecretExpiresAt = secretExpiresAt;
		const redirectUris = Array.isArray(record.redirect_uris)
			? record.redirect_uris.filter((uri): uri is string => typeof uri === "string")
			: undefined;
		if (redirectUris && redirectUris.length > 0) clientInfo.redirectUris = redirectUris;
		const issuer = optionalString(record.issuer);
		if (issuer) clientInfo.issuer = issuer;
		this.#save((entry) => ({ ...entry, clientInfo }));
	}

	tokens(_ctx?: OAuthClientInformationContext): StoredOAuthTokens | undefined {
		const tokens = this.#entry()?.tokens;
		if (!tokens?.accessToken) return undefined;
		const stored: Record<string, unknown> = { access_token: tokens.accessToken, token_type: "Bearer" };
		if (tokens.refreshToken) stored.refresh_token = tokens.refreshToken;
		if (tokens.expiresAt !== undefined) {
			// The SDK reasons in `expires_in` relative to now; a non-positive value
			// makes it refresh rather than send a dead token.
			stored.expires_in = Math.max(0, tokens.expiresAt - nowSeconds(this.#now));
		}
		if (tokens.scope) stored.scope = tokens.scope;
		if (tokens.issuer) stored.issuer = tokens.issuer;
		return stored as StoredOAuthTokens;
	}

	saveTokens(tokens: StoredOAuthTokens): void {
		const record = asRecord(tokens);
		const accessToken = optionalString(record.access_token);
		if (!accessToken) return;
		const next: McpAuthEntry["tokens"] = { accessToken };
		const refreshToken = optionalString(record.refresh_token);
		if (refreshToken) next.refreshToken = refreshToken;
		const expiresIn = optionalNumber(record.expires_in);
		if (expiresIn !== undefined) next.expiresAt = nowSeconds(this.#now) + Math.floor(expiresIn);
		const scope = optionalString(record.scope);
		if (scope) next.scope = scope;
		const issuer = optionalString(record.issuer);
		if (issuer) next.issuer = issuer;
		this.#save((entry) => {
			// A refresh response may omit the refresh token; keeping the previous one
			// is what makes the next headless refresh possible.
			const carried = next.refreshToken
				? next
				: { ...next, ...(entry.tokens?.refreshToken ? { refreshToken: entry.tokens.refreshToken } : {}) };
			return { ...entry, tokens: carried };
		});
	}

	/**
	 * Refused unless a human is driving. Reaching here without `onRedirect` means
	 * something automated wants a consent screen, which is the user's job via
	 * `/mcp-auth`, not this process's.
	 */
	async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
		const onRedirect = this.#options.onRedirect;
		if (!onRedirect) throw new McpAuthorizationRequiredError(this.#options.serverName);
		await onRedirect(authorizationUrl);
	}

	saveCodeVerifier(codeVerifier: string): void {
		this.#save((entry) => ({ ...entry, codeVerifier }));
	}

	codeVerifier(): string {
		const verifier = this.#entry()?.codeVerifier;
		if (!verifier) throw new McpAuthorizationRequiredError(this.#options.serverName);
		return verifier;
	}

	/** Drop everything for this server; used by an explicit re-auth. */
	invalidate(): void {
		this.#options.store.clear(this.#options.serverName);
	}
}
