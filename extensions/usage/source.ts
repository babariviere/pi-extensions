/**
 * Subscription-usage fetching with provider-specific cross-process caches.
 *
 * Claude uses its OAuth usage API. Codex / ChatGPT uses the undocumented
 * WHAM API used by Codex clients. Neither endpoint accepts API keys.
 */

import { execFileSync } from "node:child_process";
import {
	existsSync,
	type FSWatcher,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	watch,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RateWindow, UsageProvider, UsageSnapshot } from "./protocol.ts";

export const REFRESH_INTERVAL_MS = 60_000;
const API_TIMEOUT_MS = 5_000;
const DEFAULT_BACKOFF_MS = 60_000;
const LOCK_STALE_MS = 5_000;
const CLAUDE_USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const OPENAI_USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";

interface CachePaths {
	dir: string;
	cache: string;
	lock: string;
	backoff: string;
}

function pathsFor(provider: UsageProvider): CachePaths {
	const dir = join(homedir(), ".pi", "agent", "cache", "usage-status", provider);
	return { dir, cache: join(dir, "cache.json"), lock: join(dir, "cache.lock"), backoff: join(dir, "backoff") };
}

// ── Token loading ───────────────────────────────────────────────────────────

/** Load the Claude OAuth access token from pi's auth.json, then the macOS keychain. */
export function loadClaudeToken(): string | undefined {
	const piAuthPath = join(homedir(), ".pi", "agent", "auth.json");
	try {
		if (existsSync(piAuthPath)) {
			const data = JSON.parse(readFileSync(piAuthPath, "utf8"));
			if (typeof data.anthropic?.access === "string") return data.anthropic.access;
		}
	} catch {
		// Ignore malformed credentials.
	}
	try {
		const keychainData = execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		const parsed = JSON.parse(keychainData);
		if (
			parsed.claudeAiOauth?.scopes?.includes("user:profile") &&
			typeof parsed.claudeAiOauth.accessToken === "string"
		) {
			return parsed.claudeAiOauth.accessToken;
		}
	} catch {
		// Keychain is unavailable outside macOS, or has no Claude credential.
	}
	return undefined;
}

/** Load a ChatGPT OAuth access token from pi, then the Codex CLI credential store. */
export function loadOpenAIToken(): string | undefined {
	try {
		const auth = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8"));
		if (typeof auth["openai-codex"]?.access === "string") return auth["openai-codex"].access;
	} catch {
		// Fall through to Codex CLI credentials.
	}
	try {
		const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
		const auth = JSON.parse(readFileSync(join(codexHome, "auth.json"), "utf8"));
		if (typeof auth.tokens?.access_token === "string") return auth.tokens.access_token;
	} catch {
		// No Codex credentials are installed.
	}
	return undefined;
}

/** Only OAuth (subscription) tokens can call Anthropic's usage endpoint. */
export function isOAuthToken(token: string): boolean {
	return token.startsWith("sk-ant-oat");
}

// ── Fetch + parse ───────────────────────────────────────────────────────────

function formatExtraUsageCredits(credits: number): string {
	return (credits / 100).toFixed(2);
}

function parseRetryAfter(res: Response): number | undefined {
	const header = res.headers.get("retry-after");
	if (!header) return undefined;
	const seconds = Number(header);
	if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
	const ms = new Date(header).getTime() - Date.now();
	return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

interface FetchResult {
	snapshot: UsageSnapshot;
	retryAfterMs?: number;
}

interface OpenAIRateWindow {
	used_percent?: number;
	limit_window_seconds?: number;
	reset_at?: number;
}

/** Parse Codex's two quota windows by duration, not primary/secondary position. */
export function parseOpenAIUsage(data: unknown): UsageSnapshot {
	const rateLimit = (
		data as { rate_limit?: { primary_window?: OpenAIRateWindow; secondary_window?: OpenAIRateWindow } }
	)?.rate_limit;
	const windows: RateWindow[] = [];
	for (const window of [rateLimit?.primary_window, rateLimit?.secondary_window]) {
		if (!window || !Number.isFinite(window.used_percent)) continue;
		const isFiveHour = (window.limit_window_seconds ?? 0) <= 6 * 60 * 60;
		windows.push({
			label: isFiveHour ? "5h" : "Week",
			usedPercent: window.used_percent as number,
			...(typeof window.reset_at === "number" ? { resetsAt: new Date(window.reset_at * 1000).toISOString() } : {}),
		});
	}
	return { provider: "openai", windows };
}

async function fetchUsage(provider: UsageProvider, token: string): Promise<FetchResult> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
	try {
		const res = await fetch(provider === "anthropic" ? CLAUDE_USAGE_ENDPOINT : OPENAI_USAGE_ENDPOINT, {
			headers:
				provider === "anthropic"
					? { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" }
					: { Authorization: `Bearer ${token}`, Accept: "application/json" },
			signal: controller.signal,
		});
		if (!res.ok)
			return {
				snapshot: { provider, windows: [], error: `http ${res.status}` },
				retryAfterMs: parseRetryAfter(res),
			};
		const data = await res.json();
		if (provider === "openai") return { snapshot: parseOpenAIUsage(data) };

		const usage = data as {
			five_hour?: { utilization?: number; resets_at?: string };
			seven_day?: { utilization?: number };
			extra_usage?: { is_enabled?: boolean; used_credits?: number; monthly_limit?: number; utilization?: number };
		};
		const windows: RateWindow[] = [];
		if (usage.five_hour?.utilization !== undefined) {
			windows.push({ label: "5h", usedPercent: usage.five_hour.utilization, resetsAt: usage.five_hour.resets_at });
		}
		if (usage.seven_day?.utilization !== undefined)
			windows.push({ label: "Week", usedPercent: usage.seven_day.utilization });
		if (usage.extra_usage?.is_enabled) {
			const extra = usage.extra_usage;
			const used = extra.used_credits || 0;
			const status = (usage.five_hour?.utilization ?? 0) >= 99 ? "active" : "on";
			const label =
				extra.monthly_limit && extra.monthly_limit > 0
					? `Extra [${status}] ${formatExtraUsageCredits(used)}/${formatExtraUsageCredits(extra.monthly_limit)}`
					: `Extra [${status}] ${formatExtraUsageCredits(used)}`;
			windows.push({ label, usedPercent: extra.utilization || 0 });
		}
		return { snapshot: { provider, windows } };
	} catch {
		return { snapshot: { provider, windows: [], error: "fetch failed" } };
	} finally {
		clearTimeout(timeout);
	}
}

// ── Cross-process cache ─────────────────────────────────────────────────────

export interface CacheEntry {
	fetchedAt: number;
	snapshot: UsageSnapshot;
}

function ensureDir(paths: CachePaths): void {
	mkdirSync(paths.dir, { recursive: true });
}

export function readCache(provider: UsageProvider): CacheEntry | undefined {
	try {
		return JSON.parse(readFileSync(pathsFor(provider).cache, "utf-8")) as CacheEntry;
	} catch {
		return undefined;
	}
}

function writeCache(provider: UsageProvider, entry: CacheEntry): void {
	const paths = pathsFor(provider);
	ensureDir(paths);
	const temp = `${paths.cache}.${process.pid}.tmp`;
	writeFileSync(temp, JSON.stringify(entry), "utf-8");
	renameSync(temp, paths.cache);
}

function getGoodUsage(provider: UsageProvider, ttlMs: number): UsageSnapshot | undefined {
	const entry = readCache(provider);
	if (!entry || Date.now() - entry.fetchedAt >= ttlMs || entry.snapshot.error) return undefined;
	return entry.snapshot;
}

function tryAcquireLock(paths: CachePaths): boolean {
	ensureDir(paths);
	try {
		writeFileSync(paths.lock, String(Date.now()), { flag: "wx" });
		return true;
	} catch {
		try {
			if (Date.now() - Number(readFileSync(paths.lock, "utf-8")) > LOCK_STALE_MS) {
				unlinkSync(paths.lock);
				writeFileSync(paths.lock, String(Date.now()), { flag: "wx" });
				return true;
			}
		} catch {}
		return false;
	}
}

function releaseLock(paths: CachePaths): void {
	try {
		unlinkSync(paths.lock);
	} catch {}
}

async function waitForLock(paths: CachePaths, maxWaitMs: number): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < maxWaitMs) {
		await new Promise((resolve) => setTimeout(resolve, 100));
		if (!existsSync(paths.lock)) return true;
	}
	return false;
}

function isBackingOff(paths: CachePaths): boolean {
	try {
		return Date.now() < Number(readFileSync(paths.backoff, "utf-8"));
	} catch {
		return false;
	}
}

function writeBackoff(paths: CachePaths, retryAfterMs?: number): void {
	ensureDir(paths);
	writeFileSync(
		paths.backoff,
		String(Date.now() + (retryAfterMs && retryAfterMs > 0 ? retryAfterMs : DEFAULT_BACKOFF_MS)),
	);
}

function clearBackoff(paths: CachePaths): void {
	try {
		unlinkSync(paths.backoff);
	} catch {}
}

/** Fetch a fresh snapshot, coalescing requests across pi instances. */
export async function fetchWithCache(provider: UsageProvider, token: string): Promise<UsageSnapshot | undefined> {
	const good = getGoodUsage(provider, REFRESH_INTERVAL_MS);
	if (good) return good;
	const paths = pathsFor(provider);
	if (isBackingOff(paths)) return undefined;
	if (!tryAcquireLock(paths)) {
		if (await waitForLock(paths, 3_000)) return getGoodUsage(provider, REFRESH_INTERVAL_MS);
		return undefined;
	}
	try {
		const { snapshot, retryAfterMs } = await fetchUsage(provider, token);
		if (snapshot.error) {
			writeBackoff(paths, retryAfterMs);
			return undefined;
		}
		writeCache(provider, { fetchedAt: Date.now(), snapshot });
		clearBackoff(paths);
		return snapshot;
	} finally {
		releaseLock(paths);
	}
}

/** Watch another pi instance's cache updates for one subscription provider. */
export function watchCache(provider: UsageProvider, onChange: (entry: CacheEntry) => void): () => void {
	const paths = pathsFor(provider);
	let lastMtimeMs = 0;
	let stopped = false;
	const check = () => {
		if (stopped) return;
		try {
			const stat = statSync(paths.cache, { throwIfNoEntry: false });
			if (!stat || stat.mtimeMs === lastMtimeMs || existsSync(paths.lock)) return;
			lastMtimeMs = stat.mtimeMs;
			const entry = readCache(provider);
			if (entry && !entry.snapshot.error) onChange(entry);
		} catch {}
	};
	let watcher: FSWatcher | undefined;
	try {
		ensureDir(paths);
		if (existsSync(paths.cache)) watcher = watch(paths.cache, check);
		watcher?.unref?.();
	} catch {}
	const poll = setInterval(check, 5_000);
	poll.unref?.();
	return () => {
		stopped = true;
		watcher?.close();
		clearInterval(poll);
	};
}
