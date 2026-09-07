/** Personal Codex weekly-usage pacing, persisted across pi sessions. */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CODEX_WEEKLY_STOP_PERCENT = 100;
export const CODEX_PACING_WARNING_PERCENT = 90;
export const CODEX_DAYTIME_END_HOUR = 21;
export const CODEX_DAYTIME_START_HOUR = 7;

export type PacingWindowKind = "day" | "night";

interface WindowRecord {
	allowancePercent: number;
	usedPercent: number;
	/** The one-time near-limit warning has been delivered for this window. */
	warningSent?: boolean;
}

interface LegacyDayRecord {
	lastWeeklyPercent?: number;
	usedPercent?: number;
}

export interface PacingLedger {
	/** Incremented when persisted pacing-period semantics change. */
	version: 3;
	weekResetAt: string;
	windows: Record<string, WindowRecord>;
	/** Most recent cumulative weekly value used for delta attribution. */
	lastWeeklyPercent?: number;
	/** Set when a reset-anchored version 2 ledger was migrated. */
	migratedFromResetAnchored?: boolean;
}

export interface PacingStatus {
	weekResetAt: string;
	/** ISO start of the current fixed local-time window. */
	window?: string;
	windowKind?: PacingWindowKind;
	weeklyUsedPercent: number;
	windowsRemaining?: number;
	allowancePercent: number;
	usedWindowPercent?: number;
	remainingWindowPercent?: number;
	blocked: boolean;
	/** True until an agent has received the near-limit warning for this window. */
	warningPending: boolean;
	/** @deprecated Use window. Kept for event consumers from version 2. */
	day: string;
	/** @deprecated Use windowsRemaining. Kept for event consumers from version 2. */
	daysRemaining: number;
	/** @deprecated Use usedWindowPercent. */
	usedTodayPercent: number;
	/** @deprecated Use remainingWindowPercent. */
	remainingTodayPercent: number;
}

export interface PacingWindow {
	start: Date;
	end: Date;
	kind: PacingWindowKind;
	weight: number;
}

function localDate(year: number, month: number, day: number, hour: number): Date {
	return new Date(year, month, day, hour, 0, 0, 0);
}

function windowWeight(start: Date, kind: PacingWindowKind): number {
	// Weekend classification uses the window start date. A Saturday 21:00
	// window is therefore a weekend window even though it ends Sunday morning.
	if (start.getDay() === 0 || start.getDay() === 6) return 0.5;
	return kind === "day" ? 1 : 0.5;
}

function nextWindow(window: PacingWindow): PacingWindow {
	const start =
		window.kind === "day"
			? localDate(window.start.getFullYear(), window.start.getMonth(), window.start.getDate(), 21)
			: localDate(window.start.getFullYear(), window.start.getMonth(), window.start.getDate() + 1, 7);
	const kind: PacingWindowKind = window.kind === "day" ? "night" : "day";
	const end =
		kind === "day"
			? localDate(start.getFullYear(), start.getMonth(), start.getDate(), 21)
			: localDate(start.getFullYear(), start.getMonth(), start.getDate() + 1, 7);
	return { start, end, kind, weight: windowWeight(start, kind) };
}

/** Return the fixed local-time window containing now. 07:00 is inclusive. */
export function pacingWindow(now: Date): PacingWindow {
	const hour = now.getHours();
	const kind: PacingWindowKind = hour >= CODEX_DAYTIME_START_HOUR && hour < CODEX_DAYTIME_END_HOUR ? "day" : "night";
	const start =
		kind === "day"
			? localDate(now.getFullYear(), now.getMonth(), now.getDate(), 7)
			: hour >= CODEX_DAYTIME_END_HOUR
				? localDate(now.getFullYear(), now.getMonth(), now.getDate(), 21)
				: localDate(now.getFullYear(), now.getMonth(), now.getDate() - 1, 21);
	const end =
		kind === "day"
			? localDate(start.getFullYear(), start.getMonth(), start.getDate(), 21)
			: localDate(start.getFullYear(), start.getMonth(), start.getDate() + 1, 7);
	return { start, end, kind, weight: windowWeight(start, kind) };
}

/** Compatibility name for callers that used the old reset-anchored helper. */
export function pacingPeriodStart(now: Date, _resetAt: Date): Date {
	return pacingWindow(now).start;
}

/** The local 21:00 cutoff used by the daytime pacing override. */
export function daytimePacingEnd(now: Date): Date {
	const end = new Date(now);
	end.setHours(CODEX_DAYTIME_END_HOUR, 0, 0, 0);
	return end;
}

function remainingWindows(now: Date, resetAt: Date): PacingWindow[] {
	const current = pacingWindow(now);
	if (!Number.isFinite(resetAt.getTime()) || resetAt.getTime() <= now.getTime()) return [current];
	const windows = [current];
	let next = nextWindow(current);
	while (next.start.getTime() < resetAt.getTime()) {
		windows.push(next);
		next = nextWindow(next);
	}
	return windows;
}

/** Number of fixed local-time windows remaining through the provider reset. */
export function remainingPacingWindows(now: Date, resetAt: Date): number {
	return remainingWindows(now, resetAt).length;
}

/** Compatibility name retained for consumers of the original day-based status. */
export function remainingPacingDays(now: Date, resetAt: Date): number {
	return remainingPacingWindows(now, resetAt);
}

function isWindowRecord(value: unknown): value is WindowRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as WindowRecord;
	return (
		typeof record.allowancePercent === "number" &&
		Number.isFinite(record.allowancePercent) &&
		typeof record.usedPercent === "number" &&
		Number.isFinite(record.usedPercent)
	);
}

/** Migrate reset-anchored version 2 data without making it the current window. */
export function migratePacingLedger(value: unknown): PacingLedger | undefined {
	if (!value || typeof value !== "object") return undefined;
	const parsed = value as Partial<Omit<PacingLedger, "version">> & {
		version?: unknown;
		days?: Record<string, LegacyDayRecord>;
	};
	if (
		parsed.version === 3 &&
		typeof parsed.weekResetAt === "string" &&
		parsed.windows &&
		typeof parsed.windows === "object"
	) {
		const windows: Record<string, WindowRecord> = {};
		for (const [key, record] of Object.entries(parsed.windows)) {
			if (isWindowRecord(record)) windows[key] = record;
		}
		return {
			version: 3,
			weekResetAt: parsed.weekResetAt,
			windows,
			...(typeof parsed.lastWeeklyPercent === "number" ? { lastWeeklyPercent: parsed.lastWeeklyPercent } : {}),
			...(parsed.migratedFromResetAnchored ? { migratedFromResetAnchored: true } : {}),
		};
	}
	if (
		parsed.version !== 2 ||
		typeof parsed.weekResetAt !== "string" ||
		!parsed.days ||
		typeof parsed.days !== "object"
	) {
		return undefined;
	}
	let lastWeeklyPercent = 0;
	for (const record of Object.values(parsed.days)) {
		if (!record) continue;
		const observed =
			typeof record.lastWeeklyPercent === "number"
				? record.lastWeeklyPercent
				: typeof record.usedPercent === "number"
					? record.usedPercent
					: undefined;
		if (observed !== undefined && Number.isFinite(observed))
			lastWeeklyPercent = Math.max(lastWeeklyPercent, observed);
	}
	return {
		version: 3,
		weekResetAt: parsed.weekResetAt,
		windows: {},
		lastWeeklyPercent,
		migratedFromResetAnchored: true,
	};
}

export function observeWeeklyUsage(
	ledger: PacingLedger | undefined,
	input: { weeklyUsedPercent: number; resetAt: string; now: Date },
): { ledger: PacingLedger; status: PacingStatus } | undefined {
	const reset = new Date(input.resetAt);
	if (!Number.isFinite(reset.getTime()) || !Number.isFinite(input.weeklyUsedPercent)) return undefined;
	const weeklyUsedPercent = Math.max(0, Math.min(100, input.weeklyUsedPercent));
	const previousReset = ledger ? new Date(ledger.weekResetAt).getTime() : Number.NaN;
	const isNewWeek = !ledger || !Number.isFinite(previousReset) || previousReset !== reset.getTime();
	const active: PacingLedger = isNewWeek
		? { version: 3, weekResetAt: input.resetAt, windows: {} }
		: (ledger ?? { version: 3, weekResetAt: input.resetAt, windows: {} });
	const current = pacingWindow(input.now);
	const windowKey = current.start.toISOString();
	const futureWindows = remainingWindows(input.now, reset);
	const totalWeight = futureWindows.reduce((sum, window) => sum + window.weight, 0);
	let record = active.windows[windowKey];
	if (!record) {
		record = {
			allowancePercent: (Math.max(0, 100 - weeklyUsedPercent) * current.weight) / totalWeight,
			usedPercent: 0,
		};
		active.windows[windowKey] = record;
	}

	// Without an earlier poll, historical usage only establishes the baseline.
	// It already reduces the available weekly budget and must not also consume
	// the new window's allowance. Later polls contribute only positive deltas.
	const baseline = isNewWeek ? undefined : active.lastWeeklyPercent;
	const delta = baseline === undefined ? 0 : Math.max(0, weeklyUsedPercent - baseline);
	record.usedPercent += delta;
	active.lastWeeklyPercent = weeklyUsedPercent;

	const remainingWindowPercent = Math.max(0, record.allowancePercent - record.usedPercent);
	const blocked = weeklyUsedPercent >= CODEX_WEEKLY_STOP_PERCENT || remainingWindowPercent <= 0;
	const warningPending =
		!blocked &&
		!record.warningSent &&
		record.allowancePercent > 0 &&
		(record.usedPercent / record.allowancePercent) * 100 >= CODEX_PACING_WARNING_PERCENT;
	const status = {
		weekResetAt: input.resetAt,
		window: windowKey,
		windowKind: current.kind,
		weeklyUsedPercent,
		windowsRemaining: futureWindows.length,
		allowancePercent: record.allowancePercent,
		usedWindowPercent: record.usedPercent,
		remainingWindowPercent,
		blocked,
		warningPending,
		// These aliases preserve the published version 2 event shape.
		day: windowKey,
		daysRemaining: futureWindows.length,
		usedTodayPercent: record.usedPercent,
		remainingTodayPercent: remainingWindowPercent,
	};
	return { ledger: active, status };
}

/** Mark a window's near-limit warning as delivered, so it survives reloads and sessions. */
export function markPacingWarningSent(ledger: PacingLedger | undefined, window: string): void {
	const record = ledger?.windows[window];
	if (record) record.warningSent = true;
}

function ledgerPath(): string {
	return join(
		process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
		"cache",
		"usage-status",
		"openai",
		"pacing.json",
	);
}

function overridePath(): string {
	return join(
		process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
		"cache",
		"usage-status",
		"openai",
		"pacing-override.json",
	);
}

/** Load a future local-time pacing override, if one has been persisted. */
export function loadPacingDisabledUntil(): string | undefined {
	try {
		const parsed = JSON.parse(readFileSync(overridePath(), "utf8")) as { disabledUntil?: unknown };
		if (typeof parsed.disabledUntil !== "string") return undefined;
		const timestamp = new Date(parsed.disabledUntil).getTime();
		return Number.isFinite(timestamp) && timestamp > Date.now() ? parsed.disabledUntil : undefined;
	} catch {
		return undefined;
	}
}

export function savePacingDisabledUntil(disabledUntil: string): void {
	const path = overridePath();
	const dir = join(path, "..");
	try {
		mkdirSync(dir, { recursive: true });
		const temporary = `${path}.${process.pid}.tmp`;
		writeFileSync(temporary, JSON.stringify({ disabledUntil }), { encoding: "utf8", mode: 0o600 });
		renameSync(temporary, path);
	} catch {
		// Pacing is advisory. An unwritable cache must not break usage polling.
	}
}

export function clearPacingDisabledUntil(): void {
	try {
		unlinkSync(overridePath());
	} catch {
		// The override is already absent or the cache is unwritable.
	}
}

export function loadPacingLedger(): PacingLedger | undefined {
	try {
		const raw: unknown = JSON.parse(readFileSync(ledgerPath(), "utf8"));
		const migrated = migratePacingLedger(raw);
		if (migrated && raw && typeof raw === "object" && (raw as { version?: unknown }).version === 2) {
			// Rewrite immediately so a session that has not received a usable
			// snapshot still cannot reload reset-anchored records next time.
			savePacingLedger(migrated);
		}
		return migrated;
	} catch {
		return undefined;
	}
}

export function savePacingLedger(ledger: PacingLedger): void {
	const path = ledgerPath();
	const dir = join(path, "..");
	try {
		mkdirSync(dir, { recursive: true });
		const temporary = `${path}.${process.pid}.tmp`;
		writeFileSync(temporary, JSON.stringify(ledger), { encoding: "utf8", mode: 0o600 });
		renameSync(temporary, path);
	} catch {
		// Pacing is advisory. An unwritable cache must not break usage polling.
	}
}
