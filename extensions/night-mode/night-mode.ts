/**
 * Pure logic for the night-mode extension: window math, budget threshold and
 * resume scheduling. Dependency free so it can be unit tested without a session.
 */

export interface NightWindow {
	/** Local hour the window opens, inclusive (0-23). */
	startHour: number;
	/** Local hour the window closes, exclusive (0-23). */
	endHour: number;
}

/** 21:00 -> 09:00 local. */
export const DEFAULT_WINDOW: NightWindow = { startHour: 21, endHour: 9 };

/** Stop before the 5h window is actually exhausted, so we never spill over. */
export const DEFAULT_THRESHOLD_PERCENT = 95;

/**
 * Same margin on the weekly subscription window. Overshooting it is worse than
 * overshooting the 5h one: there is no "wait a few hours" way back.
 */
export const DEFAULT_WEEKLY_THRESHOLD_PERCENT = 95;

/** Grace period after the reported reset before trusting the new window. */
export const RESUME_BUFFER_MS = 60_000;

/** Random spread so several paused pi instances do not resume in lockstep. */
export const RESUME_JITTER_MS = 5 * 60_000;

/** Retry delay when the reset time is unknown or usage is still above threshold. */
export const RESUME_RETRY_MS = 5 * 60_000;

/**
 * Poll interval for a weekly pause. The provider reports a reset timestamp for
 * the 5h window only, so a weekly pause cannot schedule anything: it can only
 * re-read the usage snapshot now and then, and a week does not need a fine grain.
 */
export const WEEKLY_RETRY_MS = 30 * 60_000;

/**
 * True when `date` falls inside the night window. Windows that wrap past
 * midnight (start > end) are supported; start === end means "always on".
 */
export function isWithinWindow(date: Date, window: NightWindow = DEFAULT_WINDOW): boolean {
	const hour = date.getHours();
	const { startHour, endHour } = window;
	if (startHour === endHour) return true;
	if (startHour < endHour) return hour >= startHour && hour < endHour;
	return hour >= startHour || hour < endHour;
}

/**
 * A copy of `window` whose start is moved to `date`'s hour, so night mode can be
 * kicked off before the usual start hour. `startHour === endHour` (starting the
 * session exactly at the closing hour) means "on until turned off", which is the
 * intended reading of "start now, end at the usual hour tomorrow".
 */
export function windowStartingAt(date: Date, window: NightWindow = DEFAULT_WINDOW): NightWindow {
	return { startHour: date.getHours(), endHour: window.endHour };
}

/**
 * How long a run must have been going before an unchanged ledger counts as a
 * stall.
 *
 * The fingerprint check exists to stop a loop where continuation after
 * continuation changes nothing. Without a floor it also fires on a run that has
 * barely started: on 2026-08-31 it ended the night three minutes in, while four
 * subagents were still working and about to write their evidence. A first pass
 * takes tens of minutes, so anything under this is too early to call stuck.
 */
export const MIN_ELAPSED_BEFORE_STALL_MS = 15 * 60 * 1000;

/**
 * Is the run stuck? Only when a continuation was already sent, the ledger has
 * not moved since, and the run has had time to move it.
 */
export function isStalled(input: {
	nudges: number;
	fingerprint: string;
	lastFingerprint?: string;
	elapsedMs: number;
	floorMs?: number;
}): boolean {
	if (input.nudges <= 0) return false;
	if (input.lastFingerprint === undefined || input.fingerprint !== input.lastFingerprint) return false;
	return input.elapsedMs >= (input.floorMs ?? MIN_ELAPSED_BEFORE_STALL_MS);
}

/**
 * True when this session should hold a `caffeinate` process.
 *
 * Sleep is only suppressed while there is a reason for it: an agent run in
 * flight, or a pause waiting for the 5h window to reset (sleeping would stall
 * the resume timer). macOS power assertions are a union, so each pi instance
 * holding its own process means the machine sleeps once every instance is idle.
 */
export function shouldHoldCaffeinate(state: {
	enabled: boolean;
	inWindow: boolean;
	agentBusy: boolean;
	paused: boolean;
}): boolean {
	if (!state.enabled || !state.inWindow) return false;
	return state.agentBusy || state.paused;
}

/** True when the 5h window has reached the safety threshold. */
export function shouldPause(usedPercent: number | undefined, threshold: number = DEFAULT_THRESHOLD_PERCENT): boolean {
	if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) return false;
	return usedPercent >= threshold;
}

/** Which subscription window stopped the run. */
export type PauseReason = "5h" | "week";

export interface PauseThresholds {
	fiveHour?: number;
	week?: number;
}

/**
 * The window that should stop the run right now, if any. The weekly limit wins
 * when both are hit: it is the one with the longer, more expensive recovery, and
 * the resume prompt has to say so.
 */
export function pauseReasonFor(
	usage: { fiveHourPercent?: number; weekPercent?: number },
	thresholds: PauseThresholds = {},
): PauseReason | undefined {
	if (shouldPause(usage.weekPercent, thresholds.week ?? DEFAULT_WEEKLY_THRESHOLD_PERCENT)) return "week";
	if (shouldPause(usage.fiveHourPercent, thresholds.fiveHour ?? DEFAULT_THRESHOLD_PERCENT)) return "5h";
	return undefined;
}

export interface ResumeDelayOptions {
	bufferMs?: number;
	jitterMs?: number;
	retryMs?: number;
	/** Injectable for tests; must return [0, 1). */
	random?: () => number;
}

/**
 * Milliseconds to wait before attempting a resume. Falls back to a fixed retry
 * when the provider did not report a reset timestamp.
 */
export function computeResumeDelayMs(
	resetsAt: string | undefined,
	now: number,
	options: ResumeDelayOptions = {},
): number {
	const bufferMs = options.bufferMs ?? RESUME_BUFFER_MS;
	const jitterMs = options.jitterMs ?? RESUME_JITTER_MS;
	const retryMs = options.retryMs ?? RESUME_RETRY_MS;
	const random = options.random ?? Math.random;

	const resetMs = resetsAt ? new Date(resetsAt).getTime() : Number.NaN;
	if (!Number.isFinite(resetMs)) return retryMs;

	const untilReset = Math.max(0, resetMs - now);
	return untilReset + bufferMs + Math.floor(random() * jitterMs);
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * "Monday 2026-08-29 03:12", the stamp handed to a resuming agent.
 *
 * A weekly pause can span days, so "continue where you left off" is not enough
 * context: the agent has to know which day it woke up on before it trusts
 * anything it remembers about branches, PRs or CI.
 */
export function formatDayStamp(date: Date): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return (
		`${WEEKDAYS[date.getDay()]} ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
		` ${pad(date.getHours())}:${pad(date.getMinutes())}`
	);
}

/** Compact "2h34m" / "12m" / "45s" rendering of a duration. */
export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "0s";
	const totalSec = Math.round(ms / 1000);
	if (totalSec < 60) return `${totalSec}s`;
	const totalMin = Math.round(totalSec / 60);
	const h = Math.floor(totalMin / 60);
	const m = totalMin % 60;
	return h > 0 ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m`;
}

/** "21:00-09:00" rendering of a window. */
export function formatWindow(window: NightWindow): string {
	return `${String(window.startHour).padStart(2, "0")}:00-${String(window.endHour).padStart(2, "0")}:00`;
}

/** Local wall clock "03:12". */
export function formatClock(date: Date): string {
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
