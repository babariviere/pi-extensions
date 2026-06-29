/**
 * Shared helpers for the web extension: secret loading, URL classification,
 * git input sanitization, and clone cache paths.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Load a secret by name. Order of precedence:
 *   1. process.env[name]
 *   2. ~/.pi/agent/secrets.json  ({ "NAME": "value" } or { "secrets": { ... } })
 *
 * Returns undefined when not found. The secrets extension can also inject the
 * value into the environment, in which case (1) picks it up.
 */
export function loadSecret(name: string): string | undefined {
	const fromEnv = process.env[name];
	if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();

	const secretsPath = join(homedir(), ".pi", "agent", "secrets.json");
	if (!existsSync(secretsPath)) return undefined;

	try {
		const raw = readFileSync(secretsPath, "utf8");
		const data = JSON.parse(raw) as Record<string, unknown>;
		const bag =
			data && typeof data === "object" && data.secrets && typeof data.secrets === "object"
				? (data.secrets as Record<string, unknown>)
				: data;
		const value = bag?.[name];
		if (typeof value === "string" && value.trim().length > 0) return value.trim();
	} catch {
		// Malformed secrets file: treat as missing.
	}
	return undefined;
}

export interface GitHubRepoRef {
	owner: string;
	repo: string;
	/** HTTPS clone URL. */
	cloneUrl: string;
}

const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);

/**
 * Detect a clone-eligible GitHub repo URL.
 *
 * Only root (`/owner/repo`), `/tree/...`, and `/blob/...` URLs are eligible.
 * Issues, pulls, wiki, actions, discussions, releases, etc. return null so
 * they fall through to defuddle.
 */
export function parseGitHubRepoUrl(input: string): GitHubRepoRef | null {
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") return null;
	if (!GITHUB_HOSTS.has(url.hostname.toLowerCase())) return null;

	const segments = url.pathname.split("/").filter(Boolean);
	if (segments.length < 2) return null;

	const [owner, rawRepo, kind] = segments;
	const repo = rawRepo.replace(/\.git$/i, "");

	if (!isSafeSegment(owner) || !isSafeSegment(repo)) return null;

	// Eligible: root (no third segment), or tree/blob views.
	if (kind !== undefined && kind !== "tree" && kind !== "blob") return null;

	return {
		owner,
		repo,
		cloneUrl: `https://github.com/${owner}/${repo}.git`,
	};
}

/** True for raw.githubusercontent.com URLs, which we fetch as raw bytes. */
export function isRawGitHubUrl(input: string): boolean {
	try {
		const url = new URL(input);
		return url.hostname.toLowerCase() === "raw.githubusercontent.com";
	} catch {
		return false;
	}
}

/**
 * Validate an owner/repo path segment. Rejects anything with shell-sensitive
 * or path-traversal characters so values are safe to use as directory names
 * and as non-interpolated git arguments.
 */
export function isSafeSegment(segment: string): boolean {
	return /^[A-Za-z0-9._-]+$/.test(segment) && segment !== "." && segment !== "..";
}

/**
 * Deterministic clone cache path:
 *   <os-tmp>/pi-web-clones/github.com/<owner>/<repo>
 *
 * No timestamp, so a reboot (which clears the OS temp dir) is the only
 * eviction. Reused as-is across calls.
 */
export function cloneCachePath(ref: GitHubRepoRef): string {
	return join(tmpdir(), "pi-web-clones", "github.com", ref.owner, ref.repo);
}
