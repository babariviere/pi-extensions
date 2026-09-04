import assert from "node:assert/strict";
import test from "node:test";
import { markPacingWarningSent, observeWeeklyUsage, pacingPeriodStart, remainingPacingDays } from "./pacing.ts";

test("anchors pacing periods to the weekly reset's local time", () => {
	const reset = new Date(2025, 0, 4, 8, 42, 10);
	assert.deepEqual(pacingPeriodStart(new Date(2025, 0, 1, 7, 0), reset), new Date(2024, 11, 31, 8, 42, 10));
	assert.deepEqual(pacingPeriodStart(new Date(2025, 0, 1, 9, 0), reset), new Date(2025, 0, 1, 8, 42, 10));
	assert.equal(remainingPacingDays(new Date(2025, 0, 1, 7, 0), reset), 4);
	assert.equal(remainingPacingDays(new Date(2025, 0, 1, 9, 0), reset), 3);
});

test("attributes usage before the first poll to today and records observed deltas", () => {
	const now = new Date(2025, 0, 1, 12);
	const resetAt = new Date(2025, 0, 4, 8).toISOString();
	const first = observeWeeklyUsage(undefined, { weeklyUsedPercent: 40, resetAt, now });
	assert.ok(first);
	assert.ok(Math.abs(first.status.allowancePercent - (60 * 1.2) / 3.6) < 1e-9);
	assert.equal(first.status.usedTodayPercent, 40);
	assert.equal(first.status.remainingTodayPercent, 0);
	assert.equal(first.status.blocked, true);
	const next = observeWeeklyUsage(first.ledger, { weeklyUsedPercent: 47, resetAt, now });
	assert.ok(next);
	assert.equal(next.status.usedTodayPercent, 47);
	assert.equal(next.status.remainingTodayPercent, 0);
});

test("weights weekends at half baseline and boosts weekdays", () => {
	const resetAt = new Date(2025, 0, 12).toISOString();
	const weekend = observeWeeklyUsage(undefined, {
		weeklyUsedPercent: 0,
		resetAt,
		now: new Date(2025, 0, 5, 12),
	});
	const weekday = observeWeeklyUsage(undefined, {
		weeklyUsedPercent: 0,
		resetAt,
		now: new Date(2025, 0, 6, 12),
	});
	assert.ok(weekend);
	assert.ok(weekday);
	assert.equal(weekend.status.allowancePercent, (100 * 0.5) / 7);
	assert.equal(weekday.status.allowancePercent, (100 * 1.2) / 6.5);
});

test("does not attribute prior-week usage to a later day", () => {
	const resetAt = new Date(2025, 0, 4, 8).toISOString();
	const first = observeWeeklyUsage(undefined, {
		weeklyUsedPercent: 40,
		resetAt,
		now: new Date(2025, 0, 1, 12),
	});
	assert.ok(first);
	const next = observeWeeklyUsage(first.ledger, {
		weeklyUsedPercent: 40,
		resetAt,
		now: new Date(2025, 0, 2, 12),
	});
	assert.ok(next);
	assert.equal(next.status.usedTodayPercent, 0);
});

test("starts a fresh ledger when the weekly reset changes", () => {
	const now = new Date(2025, 0, 1, 12);
	const first = observeWeeklyUsage(undefined, {
		weeklyUsedPercent: 99,
		resetAt: new Date(2025, 0, 2).toISOString(),
		now,
	});
	assert.ok(first);
	const next = observeWeeklyUsage(first.ledger, {
		weeklyUsedPercent: 1,
		resetAt: new Date(2025, 0, 9).toISOString(),
		now,
	});
	assert.ok(next);
	assert.equal(next.status.usedTodayPercent, 1);
	assert.equal(next.status.blocked, false);
});

test("requests one warning at 90 percent of today's allowance", () => {
	const now = new Date(2025, 0, 1, 12);
	const resetAt = new Date(2025, 0, 2, 8).toISOString();
	const first = observeWeeklyUsage(undefined, { weeklyUsedPercent: 0, resetAt, now });
	assert.ok(first);
	const nearLimit = observeWeeklyUsage(first.ledger, { weeklyUsedPercent: 91, resetAt, now });
	assert.ok(nearLimit);
	assert.equal(nearLimit.status.warningPending, true);
	markPacingWarningSent(nearLimit.ledger, nearLimit.status.day);
	const afterWarning = observeWeeklyUsage(nearLimit.ledger, { weeklyUsedPercent: 46, resetAt, now });
	assert.ok(afterWarning);
	assert.equal(afterWarning.status.warningPending, false);
});
