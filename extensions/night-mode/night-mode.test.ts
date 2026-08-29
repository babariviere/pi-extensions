import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DEFAULT_WINDOW,
	computeResumeDelayMs,
	formatClock,
	formatDuration,
	formatWindow,
	isWithinWindow,
	shouldHoldCaffeinate,
	windowStartingAt,
	shouldPause,
	pauseReasonFor,
	formatDayStamp,
} from "./night-mode.ts";

const at = (hour: number, minute = 0): Date => new Date(2025, 0, 15, hour, minute, 0, 0);

describe("isWithinWindow", () => {
	it("covers the wrapping 21:00-09:00 window", () => {
		assert.equal(isWithinWindow(at(21)), true);
		assert.equal(isWithinWindow(at(23, 59)), true);
		assert.equal(isWithinWindow(at(0)), true);
		assert.equal(isWithinWindow(at(8, 59)), true);
	});

	it("excludes daytime hours", () => {
		assert.equal(isWithinWindow(at(9)), false);
		assert.equal(isWithinWindow(at(14)), false);
		assert.equal(isWithinWindow(at(20, 59)), false);
	});

	it("supports non-wrapping windows", () => {
		const window = { startHour: 9, endHour: 17 };
		assert.equal(isWithinWindow(at(8), window), false);
		assert.equal(isWithinWindow(at(9), window), true);
		assert.equal(isWithinWindow(at(16, 59), window), true);
		assert.equal(isWithinWindow(at(17), window), false);
	});

	it("treats start === end as always on", () => {
		assert.equal(isWithinWindow(at(3), { startHour: 0, endHour: 0 }), true);
		assert.equal(isWithinWindow(at(15), { startHour: 0, endHour: 0 }), true);
	});

	it("defaults to 21-9", () => {
		assert.deepEqual(DEFAULT_WINDOW, { startHour: 21, endHour: 9 });
	});
});

describe("windowStartingAt", () => {
	it("moves the start to the current hour and keeps the end", () => {
		assert.deepEqual(windowStartingAt(at(19, 42)), { startHour: 19, endHour: 9 });
		assert.deepEqual(windowStartingAt(at(13)), { startHour: 13, endHour: 9 });
	});

	it("makes the session active immediately", () => {
		const now = at(19, 42);
		assert.equal(isWithinWindow(now), false);
		assert.equal(isWithinWindow(now, windowStartingAt(now)), true);
	});

	it("is always on when started at the closing hour", () => {
		const window = windowStartingAt(at(9));
		assert.deepEqual(window, { startHour: 9, endHour: 9 });
		assert.equal(isWithinWindow(at(15), window), true);
	});

	it("honours a custom base window", () => {
		assert.deepEqual(windowStartingAt(at(11), { startHour: 21, endHour: 6 }), {
			startHour: 11,
			endHour: 6,
		});
	});
});

describe("formatWindow", () => {
	it("renders zero padded hours", () => {
		assert.equal(formatWindow({ startHour: 21, endHour: 9 }), "21:00-09:00");
		assert.equal(formatWindow({ startHour: 0, endHour: 17 }), "00:00-17:00");
	});
});

describe("shouldHoldCaffeinate", () => {
	const base = { enabled: true, inWindow: true, agentBusy: false, paused: false };

	it("holds while an agent run is in flight", () => {
		assert.equal(shouldHoldCaffeinate({ ...base, agentBusy: true }), true);
	});

	it("holds while paused, so the resume timer is not stalled by sleep", () => {
		assert.equal(shouldHoldCaffeinate({ ...base, paused: true }), true);
	});

	it("releases once the agent has settled", () => {
		assert.equal(shouldHoldCaffeinate(base), false);
	});

	it("never holds when disabled or outside the window", () => {
		assert.equal(shouldHoldCaffeinate({ ...base, agentBusy: true, enabled: false }), false);
		assert.equal(shouldHoldCaffeinate({ ...base, paused: true, inWindow: false }), false);
	});
});

describe("shouldPause", () => {
	it("pauses at or above the threshold", () => {
		assert.equal(shouldPause(95), true);
		assert.equal(shouldPause(99.5), true);
		assert.equal(shouldPause(100), true);
	});

	it("stays running below the threshold", () => {
		assert.equal(shouldPause(94.9), false);
		assert.equal(shouldPause(0), false);
	});

	it("never pauses on missing or bogus readings", () => {
		assert.equal(shouldPause(undefined), false);
		assert.equal(shouldPause(Number.NaN), false);
	});

	it("honours a custom threshold", () => {
		assert.equal(shouldPause(80, 75), true);
		assert.equal(shouldPause(80, 90), false);
	});
});

describe("pauseReasonFor", () => {
	it("pauses on the 5h window", () => {
		assert.equal(pauseReasonFor({ fiveHourPercent: 96, weekPercent: 10 }), "5h");
	});

	it("pauses on the weekly window", () => {
		assert.equal(pauseReasonFor({ fiveHourPercent: 3, weekPercent: 95 }), "week");
	});

	it("reports the weekly limit when both are hit", () => {
		assert.equal(pauseReasonFor({ fiveHourPercent: 99, weekPercent: 99 }), "week");
	});

	it("stays running below both thresholds", () => {
		assert.equal(pauseReasonFor({ fiveHourPercent: 50, weekPercent: 80 }), undefined);
		assert.equal(pauseReasonFor({}), undefined);
	});

	it("honours custom thresholds", () => {
		assert.equal(pauseReasonFor({ weekPercent: 80 }, { week: 75 }), "week");
		assert.equal(pauseReasonFor({ fiveHourPercent: 96 }, { fiveHour: 99 }), undefined);
	});
});

describe("formatDayStamp", () => {
	it("names the day, so a multi-day pause resumes with the right date", () => {
		assert.equal(formatDayStamp(at(3, 7)), "Wednesday 2025-01-15 03:07");
		assert.equal(formatDayStamp(new Date(2026, 7, 29, 21, 30)), "Saturday 2026-08-29 21:30");
	});
});

describe("computeResumeDelayMs", () => {
	const now = Date.UTC(2025, 0, 15, 2, 0, 0);
	const options = { bufferMs: 60_000, jitterMs: 300_000, retryMs: 300_000, random: () => 0 };

	it("waits until the reset plus the buffer", () => {
		const resetsAt = new Date(now + 30 * 60_000).toISOString();
		assert.equal(computeResumeDelayMs(resetsAt, now, options), 30 * 60_000 + 60_000);
	});

	it("adds jitter from the injected random source", () => {
		const resetsAt = new Date(now + 60_000).toISOString();
		const delay = computeResumeDelayMs(resetsAt, now, { ...options, random: () => 0.5 });
		assert.equal(delay, 60_000 + 60_000 + 150_000);
	});

	it("clamps a reset already in the past to the buffer", () => {
		const resetsAt = new Date(now - 10 * 60_000).toISOString();
		assert.equal(computeResumeDelayMs(resetsAt, now, options), 60_000);
	});

	it("falls back to the retry delay without a usable reset", () => {
		assert.equal(computeResumeDelayMs(undefined, now, options), 300_000);
		assert.equal(computeResumeDelayMs("not-a-date", now, options), 300_000);
	});
});

describe("formatting", () => {
	it("formats durations compactly", () => {
		assert.equal(formatDuration(45_000), "45s");
		assert.equal(formatDuration(12 * 60_000), "12m");
		assert.equal(formatDuration(154 * 60_000), "2h34m");
		assert.equal(formatDuration(-1), "0s");
	});

	it("formats a local wall clock", () => {
		assert.equal(formatClock(at(3, 7)), "03:07");
		assert.equal(formatClock(at(21, 30)), "21:30");
	});
});
