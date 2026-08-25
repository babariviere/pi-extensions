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

/** Grace period after the reported reset before trusting the new window. */
export const RESUME_BUFFER_MS = 60_000;

/** Random spread so several paused pi instances do not resume in lockstep. */
export const RESUME_JITTER_MS = 5 * 60_000;

/** Retry delay when the reset time is unknown or usage is still above threshold. */
export const RESUME_RETRY_MS = 5 * 60_000;

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

/** True when the 5h window has reached the safety threshold. */
export function shouldPause(
	usedPercent: number | undefined,
	threshold: number = DEFAULT_THRESHOLD_PERCENT,
): boolean {
	if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) return false;
	return usedPercent >= threshold;
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
