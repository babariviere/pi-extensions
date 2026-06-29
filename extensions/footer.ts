/**
 * Footer Extension
 *
 * A minimal footer that merges the old status-line + usage-status extensions:
 *
 *	 Line 1:	<context gauge>													 <model> • <thinking>
 *	 Line 2:	Claude <5h bar %> <Week bar %> <extra> ⟳<reset>		(Claude models only)
 *
 * Left side	→ context window usage + Claude subscription usage.
 * Right side → model id + thinking level.
 *
 * The Claude usage data comes from the undocumented OAuth usage endpoint that
 * Claude Code uses (GET https://api.anthropic.com/api/oauth/usage), authed with
 * the OAuth access token pi stores in auth.json. Results are shared between pi
 * instances on this machine through a cross-process file cache.
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
import type { ExtensionAPI, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ── Context thresholds ──────────────────────────────────────────────────────
const CONTEXT_WARNING_THRESHOLD = 70;
const CONTEXT_ERROR_THRESHOLD = 90;
const CTX_BAR_WIDTH = 12;

// Usage bar thresholds
const USAGE_WARNING_THRESHOLD = 85;
const USAGE_ERROR_THRESHOLD = 92;

// Thin bar glyphs
const BAR_FILLED = "━";
const BAR_EMPTY = "─";

// ── Usage fetch config ──────────────────────────────────────────────────────
const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const REFRESH_INTERVAL_MS = 60_000;
const API_TIMEOUT_MS = 5_000;
const DEFAULT_BACKOFF_MS = 60_000;

// Cross-process cache, shared by every pi instance on this machine.
const CACHE_DIR = join(homedir(), ".pi", "agent", "cache", "usage-status");
const CACHE_PATH = join(CACHE_DIR, "cache.json");
const LOCK_PATH = join(CACHE_DIR, "cache.lock");
const BACKOFF_PATH = join(CACHE_DIR, "backoff");
const LOCK_STALE_MS = 5_000;

// Anthropic brand orange (#D97757) as a 24-bit ANSI foreground escape.
const ORANGE = "\x1b[38;2;217;119;87m";
const RESET = "\x1b[0m";
const colorizeOrange = (text: string): string => `${ORANGE}${text}${RESET}`;

interface RateWindow {
	label: string;
	usedPercent: number;
	resetsAt?: string;
}

interface UsageSnapshot {
	windows: RateWindow[];
	error?: string;
}

// ── Token loading (vendored from usage-status.ts) ───────────────────────────

/** Load the Claude OAuth access token from pi's auth.json, then the macOS keychain. */
function loadClaudeToken(): string | undefined {
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
		const keychainData = execFileSync(
			"security",
			["find-generic-password", "-s", "Claude Code-credentials", "-w"],
			{ encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
		).trim();
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
function isOAuthToken(token: string): boolean {
	return token.startsWith("sk-ant-oat");
}

/** True when the active model is served by the Anthropic subscription. */
function isAnthropicModel(model: { provider?: string; id?: string } | undefined): boolean {
	const provider = model?.provider?.toLowerCase() ?? "";
	const id = model?.id?.toLowerCase() ?? "";
	if (provider) return provider.includes("anthropic");
	return id.includes("claude");
}

// ── Fetch + parse (vendored from usage-status.ts) ───────────────────────────

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

// ── Cross-process cache (vendored from usage-status.ts) ─────────────────────

interface CacheEntry {
	fetchedAt: number;
	snapshot: UsageSnapshot;
}

function ensureDir(): void {
	mkdirSync(CACHE_DIR, { recursive: true });
}

function readCache(): CacheEntry | undefined {
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
 * off (caller keeps showing the last good state).
 */
async function fetchWithCache(token: string): Promise<UsageSnapshot | undefined> {
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
function watchCache(onChange: (snapshot: UsageSnapshot) => void): () => void {
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
			if (entry?.snapshot && !entry.snapshot.error) onChange(entry.snapshot);
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

// ── Formatting helpers ──────────────────────────────────────────────────────

/**
 * Sanitize text for display in a single-line status. Removes newlines, tabs,
 * carriage returns, and collapses repeated spaces.
 */
function sanitizeStatusText(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

/** Formats a token count into a human-readable string. */
function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/** Compact "2h34m" until the timestamp, or undefined if past/invalid. */
function formatTimeLeft(resetsAt: string | undefined): string | undefined {
	if (!resetsAt) return undefined;
	const ms = new Date(resetsAt).getTime() - Date.now();
	if (!Number.isFinite(ms) || ms <= 0) return undefined;
	const totalMin = Math.round(ms / 60_000);
	const h = Math.floor(totalMin / 60);
	const m = totalMin % 60;
	return h > 0 ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m`;
}

function clampPercent(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(100, value));
}

/** Renders a thin filled/empty bar, colored by `colorFor(percent)`. */
function renderBar(percent: number, width: number, colorFor: (p: number) => ThemeColor, theme: Theme): string {
	const clamped = clampPercent(percent);
	const filled = Math.round((clamped / 100) * width);
	const empty = width - filled;
	return theme.fg(colorFor(clamped), BAR_FILLED.repeat(filled)) + theme.fg("dim", BAR_EMPTY.repeat(empty));
}

function contextColor(p: number): "error" | "warning" | "accent" | "success" {
	if (p >= CONTEXT_ERROR_THRESHOLD) return "error";
	if (p >= CONTEXT_WARNING_THRESHOLD) return "warning";
	if (p >= 50) return "accent";
	return "success";
}

function usageColor(p: number): "error" | "warning" | "success" {
	if (p >= USAGE_ERROR_THRESHOLD) return "error";
	if (p >= USAGE_WARNING_THRESHOLD) return "warning";
	return "success";
}

/** Build the left "context gauge" segment: `ctx ━━━━──── 42% 84k/200k`. */
function renderContextGauge(
	percent: number,
	used: number,
	total: number,
	theme: Theme,
	options?: { barWidth?: number; includeCounts?: boolean },
): string {
	const barWidth = Math.max(4, options?.barWidth ?? CTX_BAR_WIDTH);
	const bar = renderBar(percent, barWidth, contextColor, theme);
	const pct = `${Math.round(clampPercent(percent))}%`;
	const counts =
		options?.includeCounts === false || !total ? "" : ` ${formatTokens(used)}/${formatTokens(total)}`;
	return theme.fg("dim", "ctx ") + bar + " " + theme.fg("dim", pct + counts);
}

/** Build the Claude usage line: `Claude 5h ━━──── 30% Week ━──── 12% ⟳2h34m`. */
function renderUsageLine(snapshot: UsageSnapshot, theme: Theme): string {
	const dim = (s: string) => theme.fg("dim", s);

	if (snapshot.error) return colorizeOrange("Claude ") + dim(snapshot.error);
	if (snapshot.windows.length === 0) return "";

	const segments: string[] = [colorizeOrange("Claude")];

	for (const w of snapshot.windows) {
		if (w.label.startsWith("Extra")) {
			// "Extra [on]/[active] <used>/<limit>" -> "extra <used>/<limit>€"
			const value = w.label.replace(/^Extra\s*\[[^\]]*\]\s*/, "").trim();
			segments.push(dim("extra ") + `${value}€`);
			continue;
		}
		const bar = renderBar(w.usedPercent, 6, usageColor, theme);
		segments.push(`${dim(w.label)} ${bar} ${dim(`${Math.round(w.usedPercent)}%`)}`);
	}

	const fiveHour = snapshot.windows.find((w) => w.label === "5h");
	const timeLeft = formatTimeLeft(fiveHour?.resetsAt);
	if (timeLeft) segments.push(dim(`⟳${timeLeft}`));

	return segments.join(" ");
}

/** Build the right "model • thinking" segment. */
function renderModel(
	pi: ExtensionAPI,
	ctx: { model?: { id?: string; provider?: string; reasoning?: unknown } },
	showProvider: boolean,
	theme: Theme,
): string {
	const modelName = ctx.model?.id?.split("/").pop() || "no-model";
	let str = theme.fg("muted", modelName);

	if (ctx.model && showProvider && ctx.model.provider) {
		str = theme.fg("dim", `(${ctx.model.provider}) `) + str;
	}

	if (ctx.model?.reasoning) {
		const thinkingLevel = pi.getThinkingLevel() || "off";
		str += " " + theme.fg("dim", "•") + " ";
		str += thinkingLevel === "off" ? theme.fg("dim", "thinking off") : theme.fg("accent", thinkingLevel);
	}

	return str;
}

/** Home-collapsed current working directory, e.g. `~/code/project`. */
function formatProject(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (home && cwd.startsWith(home)) return `~${cwd.slice(home.length)}`;
	return cwd;
}

/**
 * Fish-style path abbreviation: shorten every component except the last to its
 * first character (keeping a leading dot for hidden dirs), e.g.
 * `~/src/github.com/acme/widgets` -> `~/s/g/a/widgets`.
 */
function abbreviatePath(path: string): string {
	const parts = path.split("/");
	if (parts.length <= 1) return path;
	const last = parts.length - 1;
	return parts
		.map((part, i) => {
			if (i === last || part === "" || part === "~") return part;
			if (part.startsWith(".")) return part.slice(0, 2);
			return part.slice(0, 1);
		})
		.join("/");
}

/** Truncate a path from the left, keeping its (more meaningful) tail. */
function truncatePathTail(path: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	if (path.length <= maxWidth) return path;
	if (maxWidth === 1) return "\u2026";
	return "\u2026" + path.slice(-(maxWidth - 1));
}

/** Lay out a left and right segment on a single line, right-aligned. */
function layoutLine(left: string, right: string, width: number): string {
	const leftW = visibleWidth(left);
	const rightW = visibleWidth(right);
	const minGap = 2;

	if (leftW + minGap + rightW <= width) {
		return left + " ".repeat(width - leftW - rightW) + right;
	}

	// Right segment is the priority (model • thinking): keep it whole, truncate
	// the left to fit. If even the right alone is too wide, truncate the right.
	const availableForLeft = width - minGap - rightW;
	if (availableForLeft > 0) {
		const truncatedLeft = truncateToWidth(left, availableForLeft, "");
		const tW = visibleWidth(truncatedLeft);
		return truncatedLeft + " ".repeat(Math.max(0, width - tW - rightW)) + right;
	}
	return truncateToWidth(right, width, "");
}

// ── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
	let tuiRef: { requestRender: () => void } | null = null;
	let footerDisposeRef: (() => void) | null = null;

	// Claude usage state
	let usageSnapshot: UsageSnapshot | undefined;
	let usageInFlight = false;
	let usageTimer: ReturnType<typeof setInterval> | undefined;
	let stopCacheWatch: (() => void) | undefined;
	let lastModel: { provider?: string; id?: string } | undefined;

	async function refreshUsage(): Promise<void> {
		if (usageInFlight) return;

		// Only meaningful for an OAuth Anthropic subscription session.
		if (!isAnthropicModel(lastModel)) {
			if (usageSnapshot) {
				usageSnapshot = undefined;
				tuiRef?.requestRender();
			}
			return;
		}
		const token = loadClaudeToken();
		if (!token || !isOAuthToken(token)) {
			if (usageSnapshot) {
				usageSnapshot = undefined;
				tuiRef?.requestRender();
			}
			return;
		}

		usageInFlight = true;
		try {
			const snapshot = await fetchWithCache(token);
			if (snapshot) {
				usageSnapshot = snapshot;
				tuiRef?.requestRender();
			}
			// Otherwise we deferred / backed off: keep showing the last good state.
		} finally {
			usageInFlight = false;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		lastModel = ctx.model;

		// Show any cached value immediately, even if stale.
		const cached = readCache()?.snapshot;
		if (cached && !cached.error && isAnthropicModel(ctx.model)) usageSnapshot = cached;

		// Clean up any previous footer to prevent leaks.
		footerDisposeRef?.();
		footerDisposeRef = null;

		ctx.ui.setFooter((tui, theme, footerData) => {
			tuiRef = tui;

			// Kick off the initial fetch + periodic refresh now that the tui exists.
			void refreshUsage();
			if (!usageTimer) {
				usageTimer = setInterval(() => void refreshUsage(), REFRESH_INTERVAL_MS);
				usageTimer.unref?.();
			}
			stopCacheWatch ??= watchCache((snapshot) => {
				if (isAnthropicModel(lastModel)) {
					usageSnapshot = snapshot;
					tuiRef?.requestRender();
				}
			});

			const dispose = () => {
				if (usageTimer) {
					clearInterval(usageTimer);
					usageTimer = undefined;
				}
				stopCacheWatch?.();
				stopCacheWatch = undefined;
				tuiRef = null;
			};
			footerDisposeRef = dispose;

			return {
				dispose,
				invalidate(): void {},
				render(width: number): string[] {
					// Context usage
					const contextUsage = ctx.getContextUsage();
					const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const percent = contextUsage?.percent ?? 0;
					const used = contextUsage?.tokens ?? Math.round((percent / 100) * contextWindow);

					const contextSegment = renderContextGauge(percent, used, contextWindow, theme);
					const modelSegment = renderModel(
						pi,
						ctx,
						footerData.getAvailableProviderCount() > 1,
						theme,
					);

					// Build the left side: project path + context gauge. The project
					// path is the expendable part, so reserve space for the context
					// gauge and model first, then truncate the path tail into whatever
					// room is left (keeping context + model fully visible).
					const ctxGap = 2;
					const modelGap = 2;
					const reserved = visibleWidth(contextSegment) + modelGap + visibleWidth(modelSegment);
					const projectRaw = abbreviatePath(formatProject(ctx.cwd));
					const projectAvail = width - reserved - ctxGap;
					const projectShown = truncatePathTail(projectRaw, Math.max(0, projectAvail));
					const leftSegment = projectShown
						? `${theme.fg("accent", projectShown)}${" ".repeat(ctxGap)}${contextSegment}`
						: contextSegment;

					const lines: string[] = [layoutLine(leftSegment, modelSegment, width)];

					if (usageSnapshot && isAnthropicModel(ctx.model)) {
						const usageLine = renderUsageLine(usageSnapshot, theme);
						if (usageLine) lines.push(truncateToWidth(usageLine, width, theme.fg("dim", "...")));
					}

					// Extension statuses (set by other extensions via ctx.ui.setStatus),
					// sorted by key alphabetically and joined on a single line.
					const extensionStatuses = footerData.getExtensionStatuses();
					if (extensionStatuses.size > 0) {
						const statusLine = Array.from(extensionStatuses.entries())
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([, text]) => sanitizeStatusText(text))
							.join(" ");
						if (statusLine) lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
					}

					return lines;
				},
			};
		});
	});

	// Model switch can flip the provider on/off; refresh immediately.
	pi.on("model_select", async (event, ctx) => {
		lastModel = event.model ?? ctx.model;
		await refreshUsage();
	});

	pi.on("session_before_switch", async (event, ctx) => {
		if (event.reason === "new") {
			lastModel = ctx.model;
			await refreshUsage();
		}
	});

	pi.on("session_shutdown", async () => {
		if (usageTimer) {
			clearInterval(usageTimer);
			usageTimer = undefined;
		}
		stopCacheWatch?.();
		stopCacheWatch = undefined;
		footerDisposeRef?.();
		footerDisposeRef = null;
	});
}
