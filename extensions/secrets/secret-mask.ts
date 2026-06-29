/**
 * secret-mask.ts — pure, dependency-free secret masking utilities.
 *
 * No imports from @mariozechner or any external module.
 * ES2022 stdlib only (String.replaceAll, RegExp, etc.).
 *
 * Consumed by: extensions/secrets.ts
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SecretEntry {
	name: string;
	value: string;
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
export function partialMask(
	token: string,
	showStart: number,
	showEnd: number,
	mask = "****",
): string {
	const minLength = showStart + showEnd + mask.length + 2;
	if (token.length < minLength) return mask;
	return token.slice(0, showStart) + mask + token.slice(-showEnd);
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
		re: /\bgithub_pat_[0-9A-Za-z_]{82}\b/g,
		showStart: 13,
		showEnd: 2,
	},
	// 7. GitHub short tokens (ghp_, gho_, ghu_, ghs_, ghr_)
	{
		label: "github-tokens",
		re: /\bgh[pousr]_[0-9A-Za-z]{36}\b/g,
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
export function maskKnownSecrets(text: string): string {
	let result = text;
	for (const p of SECRET_PATTERNS) {
		if (p.label === "pem-full-block") {
			// Whole block replaced by a fixed marker — no partial reveal.
			result = result.replace(p.re, "[REDACTED: PEM PRIVATE KEY]");
		} else if (p.group != null) {
			// Keyword-gated: mask only the captured secret value, keep the surrounding keyword.
			result = result.replace(p.re, (match: string, ...args: any[]) => {
				const group1: string = args[0];
				if (!group1) return match;
				// The captured group is always at the end of the match for these patterns.
				const gStart = match.length - group1.length;
				return match.slice(0, gStart) + partialMask(group1, p.showStart, p.showEnd);
			});
		} else {
			result = result.replace(p.re, (match: string) =>
				partialMask(match, p.showStart, p.showEnd),
			);
		}
	}
	return result;
}

// ---------------------------------------------------------------------------
// URL secret masking
// ---------------------------------------------------------------------------

/** Matches `://user:password@` — replaces only the password. */
const URL_USERINFO_RE = /(:\/\/[^:@\s/]*):([^@\s/]+)@/g;

/**
 * Strict sensitive query-param regex.
 * Only masks param values that are >= 8 chars of known-secret param names.
 * Deliberately excludes bare `key` to avoid masking ?sort_key=name.
 */
const URL_QUERY_STRICT_RE =
	/([?&](?:token|api_key|apikey|access_token|sig|signature|auth|client_secret|app_secret|password|secret|pwd)=)[A-Za-z0-9%+/=_.-]{8,}/gi;

/**
 * Mask secrets embedded in URLs:
 *   (a) userinfo credentials (`user:pass@host`)
 *   (b) sensitive query-parameter values
 */
export function maskUrls(text: string): string {
	let result = text;
	result = result.replace(URL_USERINFO_RE, "$1:****@");
	result = result.replace(URL_QUERY_STRICT_RE, "$1****");
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
	/(?:^|_)(?:PUBLIC|DISPLAY|KEYBOARD|MONKEY|TURKEY|BYPASS|PASSTHROUGH)(?:_|$)/;

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
const ENV_ASSIGN_RE =
	/^([ \t]*(?:export[ \t]+)?)([A-Za-z_][A-Za-z0-9_]*)=("?)([^\n"]*)\3/gm;

/**
 * Scan text for `NAME=VALUE` assignments (including `export NAME=VALUE`).
 * When the variable name is sensitive and the value is long enough,
 * replace the value with a partial mask.
 */
export function maskEnvAssignments(text: string): string {
	return text.replace(ENV_ASSIGN_RE, (match: string, ...args: any[]) => {
		const prefix: string = args[0];
		const name: string = args[1];
		const quote: string = args[2];
		const value: string = args[3];
		if (!shouldMaskEnvVarValue(name, value)) return match;
		return prefix + name + "=" + quote + partialMask(value, 4, 2) + quote;
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
export function scrubText(text: string, secrets: SecretEntry[]): string {
	let result = text;

	// 1. Exact fnox secret values
	const sorted = [...secrets].sort((a, b) => b.value.length - a.value.length);
	for (const secret of sorted) {
		if (secret.value.length < 8) continue;
		result = result.replaceAll(secret.value, maskFnoxSecret(secret.value, secret.name));
	}

	// 2. Known provider pattern masking
	result = maskKnownSecrets(result);

	// 3. URL-embedded secret masking
	result = maskUrls(result);

	// 4. Env-var assignment masking
	result = maskEnvAssignments(result);

	return result;
}
