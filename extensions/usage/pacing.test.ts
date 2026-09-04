import assert from "node:assert/strict";
import test from "node:test";
import { observeWeeklyUsage, remainingCalendarDays } from "./pacing.ts";

test("counts local calendar dates through the weekly reset", () => {
	assert.equal(remainingCalendarDays(new Date(2025, 0, 1, 12), new Date(2025, 0, 4, 8)), 4);
	assert.equal(remainingCalendarDays(new Date(2025, 0, 1, 12), new Date(2025, 0, 2, 0)), 1);
});

test("attributes usage before the first poll to today and records observed deltas", () => {
	const now = new Date(2025, 0, 1, 12);
	const resetAt = new Date(2025, 0, 4, 8).toISOString();
	const first = observeWeeklyUsage(undefined, { weeklyUsedPercent: 40, resetAt, now });
	assert.ok(first);
	assert.equal(first.status.allowancePercent, 15);
	assert.equal(first.status.usedTodayPercent, 40);
	assert.equal(first.status.remainingTodayPercent, 0);
	assert.equal(first.status.blocked, true);
	const next = observeWeeklyUsage(first.ledger, { weeklyUsedPercent: 47, resetAt, now });
	assert.ok(next);
	assert.equal(next.status.usedTodayPercent, 47);
	assert.equal(next.status.remainingTodayPercent, 0);
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

test("migrates an existing day's baseline into today's usage", () => {
	const now = new Date(2025, 0, 1, 12);
	const resetAt = new Date(2025, 0, 4, 8).toISOString();
	const observed = observeWeeklyUsage(
		{
			weekResetAt: resetAt,
			days: { "2025-01-01": { allowancePercent: 15, usedPercent: 0, lastWeeklyPercent: 40 } },
		},
		{ weeklyUsedPercent: 40, resetAt, now },
	);
	assert.ok(observed);
	assert.equal(observed.status.usedTodayPercent, 40);
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
