/** Personal Codex weekly-usage pacing, persisted across pi sessions. */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CODEX_WEEKLY_STOP_PERCENT = 100;

interface DayRecord {
	allowancePercent: number;
	usedPercent: number;
	lastWeeklyPercent: number;
	/** Whether weekly usage present at the day's first observation was attributed to this day. */
	initialUsageAttributed?: boolean;
}

export interface PacingLedger {
	weekResetAt: string;
	days: Record<string, DayRecord>;
}

export interface PacingStatus {
	weekResetAt: string;
	weeklyUsedPercent: number;
	day: string;
	daysRemaining: number;
	allowancePercent: number;
	usedTodayPercent: number;
	remainingTodayPercent: number;
	blocked: boolean;
}

function dayKey(date: Date): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Number of local calendar dates with any time before the weekly reset. */
export function remainingCalendarDays(now: Date, resetAt: Date): number {
	if (!Number.isFinite(resetAt.getTime()) || resetAt.getTime() <= now.getTime()) return 1;
	let cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	let days = 0;
	while (cursor.getTime() < resetAt.getTime()) {
		days++;
		cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
	}
	return Math.max(1, days);
}

/** Weekends receive half a baseline daily allowance. Weekdays receive 120%, preserving the weekly total. */
function dailyAllowanceWeight(date: Date): number {
	return date.getDay() === 0 || date.getDay() === 6 ? 0.5 : 1.2;
}

function remainingAllowanceWeight(now: Date, resetAt: Date): number {
	let cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	let weight = 0;
	while (cursor.getTime() < resetAt.getTime()) {
		weight += dailyAllowanceWeight(cursor);
		cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
	}
	return weight || dailyAllowanceWeight(now);
}

export function observeWeeklyUsage(
	ledger: PacingLedger | undefined,
	input: { weeklyUsedPercent: number; resetAt: string; now: Date },
): { ledger: PacingLedger; status: PacingStatus } | undefined {
	const reset = new Date(input.resetAt);
	if (!Number.isFinite(reset.getTime()) || !Number.isFinite(input.weeklyUsedPercent)) return undefined;
	const weeklyUsedPercent = Math.max(0, Math.min(100, input.weeklyUsedPercent));
	const isNewWindow = ledger?.weekResetAt !== input.resetAt;
	const active = isNewWindow ? { weekResetAt: input.resetAt, days: {} } : ledger;
	const day = dayKey(input.now);
	const daysRemaining = remainingCalendarDays(input.now, reset);
	let record = active.days[day];
	if (!record) {
		record = {
			allowancePercent:
				(Math.max(0, 100 - weeklyUsedPercent) * dailyAllowanceWeight(input.now)) /
				remainingAllowanceWeight(input.now, reset),
			// The API exposes only a cumulative weekly percentage. Attribute the
			// unobserved amount to today so pacing does not ignore usage that
			// occurred before pi's first poll.
			usedPercent: isNewWindow ? weeklyUsedPercent : 0,
			lastWeeklyPercent: weeklyUsedPercent,
			initialUsageAttributed: true,
		};
		active.days[day] = record;
	} else {
		// Migrate ledgers written before initial usage was attributed.
		if (!record.initialUsageAttributed) {
			record.usedPercent += record.lastWeeklyPercent;
			record.initialUsageAttributed = true;
		}
		record.usedPercent += Math.max(0, weeklyUsedPercent - record.lastWeeklyPercent);
		record.lastWeeklyPercent = weeklyUsedPercent;
	}
	const remainingTodayPercent = Math.max(0, record.allowancePercent - record.usedPercent);
	return {
		ledger: active,
		status: {
			weekResetAt: input.resetAt,
			weeklyUsedPercent,
			day,
			daysRemaining,
			allowancePercent: record.allowancePercent,
			usedTodayPercent: record.usedPercent,
			remainingTodayPercent,
			blocked: weeklyUsedPercent >= CODEX_WEEKLY_STOP_PERCENT || remainingTodayPercent <= 0,
		},
	};
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

export function loadPacingLedger(): PacingLedger | undefined {
	try {
		const parsed = JSON.parse(readFileSync(ledgerPath(), "utf8")) as PacingLedger;
		return typeof parsed.weekResetAt === "string" && parsed.days && typeof parsed.days === "object"
			? parsed
			: undefined;
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
