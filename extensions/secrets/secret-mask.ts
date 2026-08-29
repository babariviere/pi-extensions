/**
 * secret-mask.ts — pure, dependency-free secret masking utilities.
 *
 * No external module imports. ES2022 stdlib only (String.replaceAll,
 * RegExp, etc.).
 *
 * Consumed by: extensions/secrets/index.ts
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SecretEntry {
	name: string;
	value: string;
}

/**
 * Grammar of a secret reference, defined here so this module and secret-ref.ts
 * share one definition:
 *
 *   group 1: backslash when escaped (`<\secret:...>` is inert)
 *   group 2: label (lowercase slug) or NAME (authoring form)
 *   group 3: id, present on minted refs only
 *
 * Kept as a source string because a global regex carries a lastIndex and must
 * not be shared between a `test` call and a `replace` loop.
 */
export const REF_PATTERN = String.raw`<(\\?)secret:([A-Za-z][A-Za-z0-9_-]*)(?::([0-9a-f]{8,32}))?>`;

const REF_TEST_RE = new RegExp(REF_PATTERN);

/** Fresh global matcher. Callers that iterate need their own lastIndex. */
export function refMatcher(): RegExp {
	return new RegExp(REF_PATTERN, "g");
}

/** True when `text` contains a reference anywhere, escaped or not. */
export function containsRef(text: string): boolean {
	return REF_TEST_RE.test(text);
}

/**
 * Mints a reversible reference for a secret value, and answers whether an id is
 * one this session minted (see secret-ref.ts).
 *
 * Injected rather than imported so this module stays free of node:crypto. With
 * no codec every layer falls back to the older lossy partial masking.
 */
export interface RefCodec {
	mint(value: string, label: string, name?: string): string;
	hasId(id: string): boolean;
}

/** Shortest value worth referencing. Below this a match is more likely noise. */
const MIN_REF_VALUE_LENGTH = 8;

/**
 * Neutralize reference-shaped text that was already in the input.
 *
 * A file can legitimately contain `<secret:NAME>`, as a template for another
 * tool or because someone typed it. Escaping it on the way out means writing it
 * back reproduces the literal text instead of planting a real credential.
 *
 * Minted refs always carry an id this session knows, so they are left alone and
 * scrubbing stays idempotent.
 */
function escapeInboundRefs(text: string, refs: RefCodec): string {
	if (!containsRef(text)) return text;
	return text.replace(refMatcher(), (raw: string, escape: string, label: string, id: string | undefined) => {
		if (escape) return raw;
		if (id && refs.hasId(id)) return raw;
		return `<\\secret:${label}${id ? `:${id}` : ""}>`;
	});
}

/**
 * Normalize any label into the `[a-z][a-z0-9-]*` shape a ref uses. Applied
 * uniformly to fnox names and pattern labels, so a ref never reveals which of
 * the two it came from.
 */
export function slugLabel(input: string): string {
	const slug = input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "");
	const named = /^[a-z]/.test(slug) ? slug : slug ? `secret-${slug}` : "secret";
	return named.slice(0, 40).replace(/-+$/, "");
}

interface SecretPattern {
	label: string;
	re: RegExp;
	showStart: number;
	showEnd: number;
	/** When set, only this capture group index (1-based) is masked rather than the whole match. */
	group?: number;
}

// ---------------------------------------------------------------------------
// Partial masking
// ---------------------------------------------------------------------------

/**
 * Partially mask a secret value: show `showStart` chars from the start and
 * `showEnd` chars from the end, replacing the middle with `mask`.
 *
 * Returns `mask` alone when the token is too short to be meaningfully partial.
 */
export function partialMask(token: string, showStart: number, showEnd: number, mask = "****"): string {
	const minLength = showStart + showEnd + mask.length + 2;
	if (token.length < minLength) return mask;
	// token.slice(-0) === token.slice(0) (the whole token), so guard showEnd=0.
	const end = showEnd > 0 ? token.slice(-showEnd) : "";
	return token.slice(0, showStart) + mask + end;
}

// ---------------------------------------------------------------------------
// Known secret patterns — ordered most-specific first (plan section 1.16)
// ---------------------------------------------------------------------------

export const SECRET_PATTERNS: SecretPattern[] = [
	// 1. PEM private key blocks (multi-line; must come first)
	{
		label: "pem-full-block",
		re: /-----BEGIN (?:[A-Z0-9 ]{0,20})?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]{0,20})?PRIVATE KEY-----/g,
		showStart: 0,
		showEnd: 0,
	},
	// 2. Anthropic admin key
	{
		label: "anthropic-admin",
		re: /\bsk-ant-admin01-[A-Za-z0-9_-]{93}AA\b/g,
		showStart: 17,
		showEnd: 2,
	},
	// 3. Anthropic API key
	{
		label: "anthropic-api",
		re: /\bsk-ant-api03-[A-Za-z0-9_-]{93}AA\b/g,
		showStart: 15,
		showEnd: 2,
	},
	// 4. OpenAI modern keys (sk-proj-, sk-svcacct-, sk-admin-)
	{
		label: "openai-modern",
		re: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{58,74}T3BlbkFJ[A-Za-z0-9_-]{58,74}\b/g,
		showStart: 10,
		showEnd: 2,
	},
	// 5. OpenAI legacy keys
	{
		label: "openai-legacy",
		re: /\bsk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}\b/g,
		showStart: 5,
		showEnd: 2,
	},
	// 6. GitHub fine-grained PAT (github_pat_)
	{
		label: "github-pat-fine",
		// Length is nominally 82 chars but can drift; allow a range so a longer
		// token is not printed in full.
		re: /\bgithub_pat_[0-9A-Za-z_]{59,255}\b/g,
		showStart: 13,
		showEnd: 2,
	},
	// 7. GitHub short tokens (ghp_, gho_, ghu_, ghs_, ghr_)
	{
		label: "github-tokens",
		// Classic length is 36 after the prefix, but GitHub has lengthened
		// tokens before; match a range so length drift does not leak the token.
		re: /\bgh[pousr]_[0-9A-Za-z]{36,255}\b/g,
		showStart: 6,
		showEnd: 2,
	},
	// 8. Slack incoming webhook URL
	{
		label: "slack-webhook",
		re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/+]{43,56}/g,
		showStart: 39,
		showEnd: 4,
	},
	// 9. Slack config token
	{
		label: "slack-config",
		re: /\bxoxe\.xox[bp]-\d-[0-9A-Za-z]{146,166}\b/g,
		showStart: 7,
		showEnd: 2,
	},
	// 10. Slack refresh token
	{
		label: "slack-refresh",
		re: /\bxoxe-\d-[0-9A-Za-z]{146,166}\b/g,
		showStart: 7,
		showEnd: 2,
	},
	// 11. Slack user token
	{
		label: "slack-user",
		re: /\bxoxp-(?:[0-9]{10,13}-){3}[0-9A-Za-z]{28,34}\b/g,
		showStart: 7,
		showEnd: 2,
	},
	// 12. Slack bot token
	{
		label: "slack-bot",
		re: /\bxoxb-[0-9]{10,13}-[0-9]{10,13}-[0-9A-Za-z]{24,34}\b/g,
		showStart: 7,
		showEnd: 2,
	},
	// 13. Slack app-level token
	{
		label: "slack-app-level",
		re: /\bxapp-\d-[A-Z0-9]+-\d+-[a-z0-9]+/g,
		showStart: 7,
		showEnd: 2,
	},
	// 14. SendGrid API key
	{
		label: "sendgrid",
		re: /\bSG\.[A-Za-z0-9=_-]{22}\.[A-Za-z0-9=_-]{43}\b/g,
		showStart: 7,
		showEnd: 2,
	},
	// 15. GitLab OAuth application secret
	{
		label: "gitlab-oauth-secret",
		re: /\bgloas-[0-9A-Za-z_-]{64}\b/g,
		showStart: 8,
		showEnd: 2,
	},
	// 16. GitLab pipeline trigger token
	{
		label: "gitlab-trigger",
		re: /\bglptt-[0-9a-f]{40}\b/g,
		showStart: 8,
		showEnd: 2,
	},
	// 17. GitLab personal access token
	{
		label: "gitlab-pat",
		re: /\bglpat-[0-9A-Za-z_-]{20,300}\b/g,
		showStart: 8,
		showEnd: 2,
	},
	// 18. GitLab runner auth token
	{
		label: "gitlab-runner",
		re: /\bglrt-[0-9A-Za-z_-]{20}\b/g,
		showStart: 7,
		showEnd: 2,
	},
	// 19. Google OAuth access token
	{
		label: "google-oauth-access",
		re: /\bya29\.[0-9A-Za-z_-]{20,200}/g,
		showStart: 7,
		showEnd: 2,
	},
	// 20. Google OAuth refresh token
	{
		label: "google-oauth-refresh",
		re: /\b1\/\/[0-9A-Za-z_-]{43,128}\b/g,
		showStart: 5,
		showEnd: 2,
	},
	// 21. Google OAuth client secret
	{
		label: "google-oauth-secret",
		re: /\bGOCSPX-[0-9A-Za-z_-]{28}\b/g,
		showStart: 9,
		showEnd: 2,
	},
	// 22. Google API key
	{
		label: "google-api-key",
		re: /\bAIza[0-9A-Za-z_-]{35}\b/g,
		showStart: 6,
		showEnd: 2,
	},
	// 23. Stripe organization secret key
	{
		label: "stripe-org-secret",
		re: /\bsk_org_[A-Za-z0-9]{10,99}\b/g,
		showStart: 9,
		showEnd: 2,
	},
	// 24. Stripe webhook signing secret
	{
		label: "stripe-webhook-secret",
		re: /\bwhsec_[A-Za-z0-9]{32,64}\b/g,
		showStart: 8,
		showEnd: 2,
	},
	// 25. Stripe secret / restricted key
	{
		label: "stripe-secret",
		re: /\b(?:sk|rk)_(?:live|test|prod)_[A-Za-z0-9]{10,99}\b/g,
		showStart: 10,
		showEnd: 2,
	},
	// 26. Stripe publishable key
	{
		label: "stripe-publishable",
		re: /\bpk_(?:live|test)_[A-Za-z0-9]{10,99}\b/g,
		showStart: 10,
		showEnd: 2,
	},
	// 27. JWT — three base64url segments
	{
		label: "jwt",
		re: /\bey[A-Za-z0-9_-]{10,}\.ey[A-Za-z0-9_/-]{10,}\.[A-Za-z0-9_/-]{10,}/g,
		showStart: 12,
		showEnd: 4,
	},
	// 28. npm granular access token
	{
		label: "npm-token",
		re: /\bnpm_[A-Za-z0-9]{36}\b/g,
		showStart: 6,
		showEnd: 2,
	},
	// 29. Hugging Face token
	{
		label: "huggingface",
		re: /\bhf_[A-Za-z]{34}\b/g,
		showStart: 5,
		showEnd: 2,
	},
	// 30. AWS access key ID
	{
		label: "aws-access-key-id",
		re: /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}\b/g,
		showStart: 6,
		showEnd: 2,
	},
	// 31. Twilio Account SID (short prefix — low precision, kept in list)
	{
		label: "twilio-account-sid",
		re: /\bAC[0-9a-fA-F]{32}\b/g,
		showStart: 4,
		showEnd: 2,
	},
	// 32. Twilio API key SID
	{
		label: "twilio-api-key",
		re: /\bSK[0-9a-fA-F]{32}\b/g,
		showStart: 4,
		showEnd: 2,
	},
	// 33. AWS secret access key (keyword-gated; group 1 is the key value)
	{
		label: "aws-secret-key",
		re: /aws[\w.\-= :'"]{0,25}([A-Za-z0-9/+]{40})/gi,
		showStart: 4,
		showEnd: 2,
		group: 1,
	},
	// 34. Authorization / API header bearer token (keyword-gated; group 1 is the token value)
	{
		label: "auth-header-bearer",
		re: /(?:Authorization|x-api-key|x-auth-token|x-access-token):\s*(?:bearer\s+)?([A-Za-z0-9_.~+/=\-]{20,})/gi,
		showStart: 4,
		showEnd: 2,
		group: 1,
	},
];

// ---------------------------------------------------------------------------
// Mask known patterns
// ---------------------------------------------------------------------------

/**
 * Scan `text` for all known secret patterns and replace matches with
 * a partial mask. Patterns are applied in the order declared above
 * (most specific first).
 */
export function maskKnownSecrets(text: string, refs?: RefCodec): string {
	let result = text;
	for (const p of SECRET_PATTERNS) {
		if (p.label === "pem-full-block") {
			// A PEM block is a value like any other: with refs it stays restorable, so
			// editing a file that holds a private key no longer destroys the key.
			result = result.replace(p.re, (match: string) =>
				refs ? refs.mint(match, "pem-private-key") : "[REDACTED: PEM PRIVATE KEY]",
			);
		} else if (p.group != null) {
			// Keyword-gated: mask only the captured secret value, keep the surrounding keyword.
			result = result.replace(p.re, (match: string, ...args: any[]) => {
				const group1: string = args[0];
				if (!group1) return match;
				// The captured group is always at the end of the match for these patterns.
				const gStart = match.length - group1.length;
				const replacement = refs ? refs.mint(group1, p.label) : partialMask(group1, p.showStart, p.showEnd);
				return match.slice(0, gStart) + replacement;
			});
		} else {
			result = result.replace(p.re, (match: string) =>
				refs ? refs.mint(match, p.label) : partialMask(match, p.showStart, p.showEnd),
			);
		}
	}
	return result;
}

// ---------------------------------------------------------------------------
// URL secret masking
// ---------------------------------------------------------------------------

/** Matches `://user:****@` — replaces only the password. */
const URL_USERINFO_RE = /(:\/\/[^:@\s/]*):([^@\s/]+)@/g;

/**
 * Strict sensitive query-param regex.
 * Only masks param values that are >= 8 chars of known-secret param names.
 * Deliberately excludes bare `key` to avoid masking ?sort_key=name.
 */
const URL_QUERY_STRICT_RE =
	/([?&])(token|api_key|apikey|access_token|sig|signature|auth|client_secret|app_secret|password|secret|pwd)=([A-Za-z0-9%+/=_.-]{8,})/gi;

/**
 * Mask secrets embedded in URLs:
 *   (a) userinfo credentials (`user:pass@host`)
 *   (b) sensitive query-parameter values
 */
export function maskUrls(text: string, refs?: RefCodec): string {
	let result = text;
	result = result.replace(URL_USERINFO_RE, (match, prefix: string, password: string) => {
		// A value that merely contains a ref must not be wrapped in a second one:
		// hydration would then return the inner ref instead of the secret.
		if (containsRef(password)) return match;
		const usable = refs && password.length >= MIN_REF_VALUE_LENGTH;
		const replacement = usable ? refs.mint(password, "url-password") : "****";
		return `${prefix}:${replacement}@`;
	});
	result = result.replace(URL_QUERY_STRICT_RE, (match, sep: string, param: string, value: string) => {
		if (containsRef(value)) return match;
		const usable = refs && value.length >= MIN_REF_VALUE_LENGTH;
		const replacement = usable ? refs.mint(value, `url-${param}`) : "****";
		return `${sep}${param}=${replacement}`;
	});
	return result;
}

// ---------------------------------------------------------------------------
// Env-var name sensitivity detection
// ---------------------------------------------------------------------------

/**
 * Explicit false-positive exclusions (checked before the sensitive list).
 * Uses underscore as word boundary (consistent with env var naming).
 */
const SENSITIVE_EXCLUSIONS =
	/(?:^|_)(?:PUBLIC|DISPLAY|KEYBOARD|MONKEY|TURKEY|BYPASS|PASSTHROUGH)(?:_|$)|(?:^|_)(?:SORT|PARTITION|PRIMARY|FOREIGN|IDEMPOTENCY|ROUTING|GROUPING|SHARD|MAP)_KEY(?:_|$)/;

/**
 * Names that indicate the value should be treated as a secret.
 * Note: API_KEY and ACCESS_KEY contain underscores — they must appear at
 * word boundaries (_API_KEY_ or ^API_KEY$, etc.).
 */
const SENSITIVE_NAME_RE =
	/(?:^|_)(?:SECRET|PASSWORD|PASSWD|PASS|PWD|PRIVATE|CREDENTIAL|CREDENTIALS|API_KEY|APIKEY|ACCESS_KEY|ACCESS_TOKEN|TOKEN|AUTH_TOKEN|AUTHTOKEN|KEY)(?:_|$)/;

/**
 * Returns true when an env var name implies its value is a secret.
 * Case-insensitive; uses underscore as the word separator.
 */
export function isSensitiveEnvVarName(name: string): boolean {
	const upper = name.toUpperCase();
	if (SENSITIVE_EXCLUSIONS.test(upper)) return false;
	return SENSITIVE_NAME_RE.test(upper);
}

/**
 * Returns true when the env var should have its value masked:
 * the name is sensitive AND the value is long enough to be a real secret.
 */
export function shouldMaskEnvVarValue(name: string, value: string): boolean {
	return value.length >= 8 && isSensitiveEnvVarName(name);
}

// ---------------------------------------------------------------------------
// Env-assignment masking
// ---------------------------------------------------------------------------

/**
 * Matches `[export ]NAME=value` and `[export ]NAME="value"` lines.
 * Group 1: optional indent/export prefix
 * Group 2: variable name
 * Group 3: optional double-quote delimiter
 * Group 4: value (no newlines or quotes)
 * \3: closing quote (backreference)
 */
const ENV_ASSIGN_RE = /^([ \t]*(?:export[ \t]+)?)([A-Za-z_][A-Za-z0-9_]*)=("?)([^\n"]*)\3/gm;

/**
 * Scan text for `NAME=VALUE` assignments (including `export NAME=VALUE`).
 * When the variable name is sensitive and the value is long enough,
 * replace the value with a partial mask.
 */
export function maskEnvAssignments(text: string, refs?: RefCodec): string {
	return text.replace(ENV_ASSIGN_RE, (match: string, ...args: any[]) => {
		const prefix: string = args[0];
		const name: string = args[1];
		const quote: string = args[2];
		const value: string = args[3];
		if (!shouldMaskEnvVarValue(name, value)) return match;
		// A value that merely contains a ref (`AUTH=Bearer <secret:...>`) must not be
		// wrapped in a second one, or hydration returns the inner ref and the secret
		// is lost with nothing reported.
		if (containsRef(value)) return match;
		// The name is only a hint here: an assignment in an arbitrary file is not
		// proof that the value is backed by an env var of that name, so the entry
		// stays unnamed and its ref cannot be used in bash.
		const replacement = refs ? refs.mint(value, name) : partialMask(value, 4, 2);
		return prefix + name + "=" + quote + replacement + quote;
	});
}

// ---------------------------------------------------------------------------
// fnox-specific partial masking (exact-value secrets from the CLI)
// ---------------------------------------------------------------------------

/**
 * Known token prefixes in detection order (most specific first).
 * Each entry is [prefix, prefixLength].
 */
const KNOWN_TOKEN_PREFIXES: [string, number][] = [
	["sk-ant-admin01-", 15],
	["sk-ant-api03-", 13],
	["sk-svcacct-", 11],
	["sk-admin-", 9],
	["sk-proj-", 8],
	["github_pat_", 11],
	["ghp_", 4],
	["gho_", 4],
	["ghu_", 4],
	["ghs_", 4],
	["ghr_", 4],
	["xoxe.xox", 8],
	["xoxp-", 5],
	["xoxb-", 5],
	["xapp-", 5],
	["xoxe-", 5],
	["sk_live_", 8],
	["sk_test_", 8],
	["rk_live_", 8],
	["rk_test_", 8],
	["sk_org_", 7],
	["pk_live_", 8],
	["pk_test_", 8],
	["whsec_", 6],
	["npm_", 4],
	["hf_", 3],
	["AIza", 4],
	["GOCSPX-", 7],
	["ya29.", 5],
	["glpat-", 6],
	["gloas-", 6],
	["glptt-", 6],
	["glrt-", 5],
	["SG.", 3],
	["AKIA", 4],
	["ASIA", 4],
	["ABIA", 4],
	["ACCA", 4],
];

function detectPrefixLen(value: string): number {
	for (const [prefix, len] of KNOWN_TOKEN_PREFIXES) {
		if (value.startsWith(prefix)) return len;
	}
	return 4;
}

/**
 * Produce a partial-mask label for a fnox-loaded secret value.
 * Shows enough of the prefix to identify the credential type.
 * Example: `[GH_TOKEN: ghp_aa****ef]`
 */
export function maskFnoxSecret(value: string, name: string): string {
	const prefixLen = detectPrefixLen(value);
	const showStart = Math.min(prefixLen + 2, 8);
	return `[${name}: ${partialMask(value, showStart, 2)}]`;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Apply all masking layers to `text` in the correct order:
 *   1. Exact fnox secret values (longest first, skip values < 8 chars)
 *   2. Known provider patterns (GitHub, AWS, OpenAI, Stripe, etc.)
 *   3. URL-embedded secrets (userinfo + sensitive query params)
 *   4. Env-var assignments with sensitive names
 */
export function scrubText(text: string, secrets: SecretEntry[], refs?: RefCodec): string {
	// 0. Neutralize reference-shaped text that was already there, before any
	// minting, so an on-disk placeholder never expands into a real credential.
	let result = refs ? escapeInboundRefs(text, refs) : text;

	// 1. Exact fnox secret values
	const sorted = [...secrets].sort((a, b) => b.value.length - a.value.length);
	for (const secret of sorted) {
		if (secret.value.length < MIN_REF_VALUE_LENGTH) continue;
		const replacement = refs
			? refs.mint(secret.value, secret.name, secret.name)
			: maskFnoxSecret(secret.value, secret.name);
		result = result.replaceAll(secret.value, replacement);
	}

	// 2. Known provider pattern masking
	result = maskKnownSecrets(result, refs);

	// 3. URL-embedded secret masking
	result = maskUrls(result, refs);

	// 4. Env-var assignment masking
	result = maskEnvAssignments(result, refs);

	return result;
}

/**
 * Scrub strings nested inside plain objects and arrays.
 *
 * Tool result `details` are persisted to the session file, so a secret that only
 * appears there still lands on disk unmasked unless it is scrubbed too.
 * Non-plain objects are returned untouched: rebuilding them would drop their
 * prototype, and they are not what carries tool text.
 *
 * Returns the input by reference when nothing changed. Callers use that identity
 * to decide whether to patch a tool result at all, and patching an untouched
 * result is not free (see scrubContent).
 */
export function scrubDeep<T>(input: T, secrets: SecretEntry[], refs?: RefCodec): T {
	return scrubDeepInternal(input, secrets, refs, new Map()) as T;
}

/**
 * The memo doubles as the cycle guard and as shared-subtree caching. A plain
 * visited-set would return the *unscrubbed* original for the second reference to
 * a shared object, which quietly leaks the secret into the session file.
 *
 * A true cycle still resolves to the original object for the back edge, because
 * its scrubbed form does not exist yet. Tool details are trees in practice.
 */
function scrubDeepInternal(
	input: unknown,
	secrets: SecretEntry[],
	refs: RefCodec | undefined,
	memo: Map<object, unknown>,
): unknown {
	if (typeof input === "string") return scrubText(input, secrets, refs);
	if (input === null || typeof input !== "object") return input;
	if (memo.has(input)) return memo.get(input);

	if (Array.isArray(input)) {
		memo.set(input, input);
		let changed = false;
		const out = input.map((item) => {
			const next = scrubDeepInternal(item, secrets, refs, memo);
			if (next !== item) changed = true;
			return next;
		});
		const result = changed ? out : input;
		memo.set(input, result);
		return result;
	}

	const proto = Object.getPrototypeOf(input);
	if (proto !== Object.prototype && proto !== null) return input;

	memo.set(input, input);
	let changed = false;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input)) {
		const next = scrubDeepInternal(value, secrets, refs, memo);
		if (next !== value) changed = true;
		out[key] = next;
	}
	const result = changed ? out : input;
	memo.set(input, result);
	return result;
}

/**
 * Scrub a tool_result content array, returning undefined when nothing changed.
 *
 * Returning a patch for an untouched result is not free: downstream consumers
 * treat any patch as a rewrite. Spindle's nested-call proxy, for one, rebuilds
 * its value from the content text, which turns a structured `agents.run` result
 * into a JSON string. Mapping over the parts always yields a fresh array, so
 * identity cannot be the change signal; compare the text instead.
 */
export function scrubContent<T extends { type: string; text?: string }>(
	content: readonly T[],
	secrets: SecretEntry[],
	refs?: RefCodec,
): T[] | undefined {
	let changed = false;
	const scrubbed = content.map((part) => {
		if (part.type !== "text" || typeof part.text !== "string") return part;
		const text = scrubText(part.text, secrets, refs);
		if (text === part.text) return part;
		changed = true;
		return { ...part, text };
	});
	return changed ? scrubbed : undefined;
}
