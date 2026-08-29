/**
 * Usage fetching + cross-process cache.
 *
 * Vendored out of the old `footer` extension so a single poller can serve every
 * consumer. Data comes from the undocumented OAuth usage endpoint that Claude
 * Code uses (GET https://api.anthropic.com/api/oauth/usage), authed with the
 * OAuth access token pi stores in auth.json. Results are shared between pi
 * instances on this machine through a file cache guarded by a lock file.
 */

import { execFileSync } from "node:child_process";
import {
	type FSWatcher,
	existsSync,
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
import type { RateWindow, UsageSnapshot } from "./protocol.ts";

export const REFRESH_INTERVAL_MS = 60_000;
const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const API_TIMEOUT_MS = 5_000;
const DEFAULT_BACKOFF_MS = 60_000;

// Cross-process cache, shared by every pi instance on this machine.
const CACHE_DIR = join(homedir(), ".pi", "agent", "cache", "usage-status");
const CACHE_PATH = join(CACHE_DIR, "cache.json");
const LOCK_PATH = join(CACHE_DIR, "cache.lock");
const BACKOFF_PATH = join(CACHE_DIR, "backoff");
const LOCK_STALE_MS = 5_000;

// ── Token loading ───────────────────────────────────────────────────────────

/** Load the Claude OAuth access token from pi's auth.json, then the macOS keychain. */
export function loadClaudeToken(): string | undefined {
	const piAuthPath = join(homedir(), ".pi", "agent", "auth.json");
	try {
		if (existsSync(piAuthPath)) {
			const data = JSON.parse(readFileSync(piAuthPath, "utf8"));
			if (data.anthropic?.access) return data.anthropic.access as string;
		}
	} catch {
		// ignore parse errors
	}

	try {
		const keychainData = execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		if (keychainData) {
			const parsed = JSON.parse(keychainData);
			const scopes = parsed.claudeAiOauth?.scopes || [];
			if (scopes.includes("user:profile") && parsed.claudeAiOauth?.accessToken) {
				return parsed.claudeAiOauth.accessToken as string;
			}
		}
	} catch {
		// keychain access failed / not macOS
	}

	return undefined;
}

/** Only OAuth (subscription) tokens can call the usage endpoint. */
export function isOAuthToken(token: string): boolean {
	return token.startsWith("sk-ant-oat");
}

// ── Fetch + parse ───────────────────────────────────────────────────────────

function formatExtraUsageCredits(credits: number): string {
	return (credits / 100).toFixed(2);
}

/** Parse a Retry-After header into milliseconds, or undefined. */
function parseRetryAfter(res: Response): number | undefined {
	const header = res.headers.get("retry-after");
	if (!header) return undefined;
	const seconds = Number(header);
	if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
	const date = new Date(header);
	if (!Number.isNaN(date.getTime())) {
		const ms = date.getTime() - Date.now();
		return ms > 0 ? ms : undefined;
	}
	return undefined;
}

interface FetchResult {
	snapshot: UsageSnapshot;
	retryAfterMs?: number;
}

async function fetchUsage(token: string): Promise<FetchResult> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

	try {
		const res = await fetch(USAGE_ENDPOINT, {
			headers: {
				Authorization: `Bearer ${token}`,
				"anthropic-beta": "oauth-2025-04-20",
			},
			signal: controller.signal,
		});
		clearTimeout(timeout);

		if (!res.ok) {
			return { snapshot: { windows: [], error: `http ${res.status}` }, retryAfterMs: parseRetryAfter(res) };
		}

		const data = (await res.json()) as {
			five_hour?: { utilization?: number; resets_at?: string };
			seven_day?: { utilization?: number };
			extra_usage?: {
				is_enabled?: boolean;
				used_credits?: number;
				monthly_limit?: number;
				utilization?: number;
			};
		};

		const windows: RateWindow[] = [];

		if (data.five_hour?.utilization !== undefined) {
			windows.push({
				label: "5h",
				usedPercent: data.five_hour.utilization,
				resetsAt: data.five_hour.resets_at,
			});
		}
		if (data.seven_day?.utilization !== undefined) {
			windows.push({ label: "Week", usedPercent: data.seven_day.utilization });
		}

		if (data.extra_usage?.is_enabled === true) {
			const extra = data.extra_usage;
			const usedCredits = extra.used_credits || 0;
			const monthlyLimit = extra.monthly_limit;
			// "active" when the 5h window is exhausted, otherwise "on".
			const extraStatus = (data.five_hour?.utilization ?? 0) >= 99 ? "active" : "on";
			const label =
				monthlyLimit && monthlyLimit > 0
					? `Extra [${extraStatus}] ${formatExtraUsageCredits(usedCredits)}/${formatExtraUsageCredits(monthlyLimit)}`
					: `Extra [${extraStatus}] ${formatExtraUsageCredits(usedCredits)}`;
			windows.push({ label, usedPercent: extra.utilization || 0 });
		}

		return { snapshot: { windows } };
	} catch {
		clearTimeout(timeout);
		return { snapshot: { windows: [], error: "fetch failed" } };
	}
}

// ── Cross-process cache ─────────────────────────────────────────────────────

export interface CacheEntry {
	fetchedAt: number;
	snapshot: UsageSnapshot;
}

function ensureDir(): void {
	mkdirSync(CACHE_DIR, { recursive: true });
}

export function readCache(): CacheEntry | undefined {
	try {
		return JSON.parse(readFileSync(CACHE_PATH, "utf-8")) as CacheEntry;
	} catch {
		return undefined;
	}
}

function writeCache(entry: CacheEntry): void {
	ensureDir();
	const tempPath = `${CACHE_PATH}.${process.pid}.tmp`;
	writeFileSync(tempPath, JSON.stringify(entry), "utf-8");
	renameSync(tempPath, CACHE_PATH);
}

/** Fresh good snapshot, or undefined if stale/missing. */
function getGoodUsage(ttlMs: number): UsageSnapshot | undefined {
	const entry = readCache();
	if (!entry) return undefined;
	if (Date.now() - entry.fetchedAt >= ttlMs) return undefined;
	return entry.snapshot;
}

function tryAcquireLock(): boolean {
	ensureDir();
	try {
		writeFileSync(LOCK_PATH, String(Date.now()), { flag: "wx" });
		return true;
	} catch {
		try {
			const lockTime = parseInt(readFileSync(LOCK_PATH, "utf-8"), 10);
			if (Date.now() - lockTime > LOCK_STALE_MS) {
				writeFileSync(LOCK_PATH, String(Date.now()));
				return true;
			}
		} catch {
			// ignore
		}
		return false;
	}
}

function releaseLock(): void {
	try {
		unlinkSync(LOCK_PATH);
	} catch {
		// ignore
	}
}

async function waitForLock(maxWaitMs: number): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < maxWaitMs) {
		await new Promise((resolve) => setTimeout(resolve, 100));
		if (!existsSync(LOCK_PATH)) return true;
	}
	return false;
}

function isBackingOff(): boolean {
	try {
		return Date.now() < parseInt(readFileSync(BACKOFF_PATH, "utf-8"), 10);
	} catch {
		return false;
	}
}

function writeBackoff(retryAfterMs?: number): void {
	ensureDir();
	const backoffMs = retryAfterMs && retryAfterMs > 0 ? retryAfterMs : DEFAULT_BACKOFF_MS;
	writeFileSync(BACKOFF_PATH, String(Date.now() + backoffMs));
}

function clearBackoff(): void {
	try {
		unlinkSync(BACKOFF_PATH);
	} catch {
		// ignore
	}
}

/**
 * Fetch with lock + backoff coordination across instances. Returns a fresh
 * good snapshot, or undefined if it deferred to another instance / is backing
 * off (caller keeps publishing the last good state).
 */
export async function fetchWithCache(token: string): Promise<UsageSnapshot | undefined> {
	const good = getGoodUsage(REFRESH_INTERVAL_MS);
	if (good) return good;

	if (isBackingOff()) return undefined;

	if (!tryAcquireLock()) {
		if (await waitForLock(3000)) {
			const fresh = getGoodUsage(REFRESH_INTERVAL_MS);
			if (fresh) return fresh;
		}
		return undefined;
	}

	try {
		const { snapshot, retryAfterMs } = await fetchUsage(token);
		if (snapshot.error) {
			writeBackoff(retryAfterMs);
			return undefined;
		}
		writeCache({ fetchedAt: Date.now(), snapshot });
		clearBackoff();
		return snapshot;
	} finally {
		releaseLock();
	}
}

/** Watch the cache file for good updates from other instances. */
export function watchCache(onChange: (entry: CacheEntry) => void): () => void {
	let lastMtimeMs = 0;
	let stopped = false;

	const check = () => {
		if (stopped) return;
		try {
			const stat = statSync(CACHE_PATH, { throwIfNoEntry: false });
			if (!stat || stat.mtimeMs === lastMtimeMs) return;
			if (existsSync(LOCK_PATH)) return; // mid-write
			lastMtimeMs = stat.mtimeMs;
			const entry = readCache();
			if (entry?.snapshot && !entry.snapshot.error) onChange(entry);
		} catch {
			// ignore
		}
	};

	let watcher: FSWatcher | undefined;
	try {
		ensureDir();
		if (existsSync(CACHE_PATH)) watcher = watch(CACHE_PATH, () => check());
		watcher?.unref?.();
	} catch {
		// fall back to polling only
	}
	const pollTimer = setInterval(check, 5_000);
	pollTimer.unref?.();

	return () => {
		stopped = true;
		watcher?.close();
		clearInterval(pollTimer);
	};
}
