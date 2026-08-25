import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DEFAULT_WINDOW,
	computeResumeDelayMs,
	formatClock,
	formatDuration,
	isWithinWindow,
	shouldPause,
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
