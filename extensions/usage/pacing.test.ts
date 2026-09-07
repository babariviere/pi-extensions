import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	daytimePacingEnd,
	loadPacingLedger,
	markPacingWarningSent,
	migratePacingLedger,
	observeWeeklyUsage,
	pacingPeriodStart,
	pacingWindow,
	remainingPacingDays,
	remainingPacingWindows,
	type PacingLedger,
} from "./pacing.ts";

test("uses fixed local windows at exact 07:00 and 21:00 boundaries", () => {
	const beforeDay = pacingWindow(new Date(2025, 0, 6, 6, 59, 59));
	assert.equal(beforeDay.kind, "night");
	assert.deepEqual(beforeDay.start, new Date(2025, 0, 5, 21));
	const day = pacingWindow(new Date(2025, 0, 6, 7, 0));
	assert.equal(day.kind, "day");
	assert.deepEqual(day.start, new Date(2025, 0, 6, 7));
	assert.deepEqual(pacingWindow(new Date(2025, 0, 6, 20, 59, 59)).start, new Date(2025, 0, 6, 7));
	const night = pacingWindow(new Date(2025, 0, 6, 21, 0));
	assert.equal(night.kind, "night");
	assert.deepEqual(night.start, new Date(2025, 0, 6, 21));
	assert.deepEqual(pacingPeriodStart(new Date(2025, 0, 6, 7), new Date(2025, 0, 6, 11, 42)), day.start);
});

test("daytime override still ends at local 21:00", () => {
	assert.deepEqual(daytimePacingEnd(new Date(2025, 0, 1, 14, 30)), new Date(2025, 0, 1, 21));
});

test("Monday 07:00 is independent of a later provider reset", () => {
	const resetAt = new Date(2025, 0, 6, 11, 42).toISOString();
	const ledger: PacingLedger = {
		version: 3,
		weekResetAt: resetAt,
		windows: {
			[new Date(2025, 0, 5, 21).toISOString()]: { allowancePercent: 10, usedPercent: 10 },
		},
		lastWeeklyPercent: 10,
	};
	const result = observeWeeklyUsage(ledger, { weeklyUsedPercent: 10, resetAt, now: new Date(2025, 0, 6, 7) });
	assert.ok(result);
	assert.equal(result.status.windowKind, "day");
	assert.equal(result.status.blocked, false);
	assert.equal(result.status.usedWindowPercent, 0);
	assert.equal(result.status.windowsRemaining, 1);
});

test("classifies crossing-midnight windows by their start date", () => {
	const friday = pacingWindow(new Date(2025, 0, 10, 21));
	const saturday = pacingWindow(new Date(2025, 0, 11, 7));
	const saturdayNight = pacingWindow(new Date(2025, 0, 11, 21));
	const sunday = pacingWindow(new Date(2025, 0, 12, 7));
	const monday = pacingWindow(new Date(2025, 0, 13, 7));
	assert.equal(friday.weight, 0.5);
	assert.equal(saturday.weight, 0.5);
	assert.equal(saturdayNight.weight, 0.5);
	assert.equal(sunday.weight, 0.5);
	assert.equal(monday.weight, 1);
});

test("normalizes weekday day, weekday night, and weekend window weights", () => {
	const reset = new Date(2025, 0, 13, 7);
	const mondayDay = observeWeeklyUsage(undefined, {
		weeklyUsedPercent: 0,
		resetAt: reset.toISOString(),
		now: new Date(2025, 0, 6, 7),
	});
	assert.ok(mondayDay);
	assert.equal(remainingPacingWindows(new Date(2025, 0, 6, 7), reset), 14);
	assert.equal(remainingPacingDays(new Date(2025, 0, 6, 7), reset), 14);
	assert.equal(mondayDay.status.allowancePercent, 100 / 9.5);
	const mondayNight = observeWeeklyUsage(mondayDay.ledger, {
		weeklyUsedPercent: 0,
		resetAt: reset.toISOString(),
		now: new Date(2025, 0, 6, 21),
	});
	assert.ok(mondayNight);
	assert.equal(mondayNight.status.allowancePercent, 50 / 8.5);
	const saturdayDay = observeWeeklyUsage(mondayNight.ledger, {
		weeklyUsedPercent: 0,
		resetAt: reset.toISOString(),
		now: new Date(2025, 0, 11, 7),
	});
	assert.ok(saturdayDay);
	assert.equal(saturdayDay.status.allowancePercent, 25);
});

test("allocates the remaining weekly budget across later windows", () => {
	const resetAt = new Date(2025, 0, 13, 7).toISOString();
	const first = observeWeeklyUsage(undefined, {
		weeklyUsedPercent: 20,
		resetAt: resetAt,
		now: new Date(2025, 0, 6, 7),
	});
	assert.ok(first);
	assert.equal(first.status.usedWindowPercent, 0);
	const later = observeWeeklyUsage(first.ledger, {
		weeklyUsedPercent: 22,
		resetAt: resetAt,
		now: new Date(2025, 0, 6, 21),
	});
	assert.ok(later);
	assert.equal(later.status.usedWindowPercent, 2);
	assert.equal(later.status.allowancePercent, (78 * 0.5) / 8.5);
	assert.equal(later.status.blocked, false);
});

test("baselines midweek historical usage, then records only positive deltas", () => {
	const now = new Date(2025, 0, 8, 12);
	const resetAt = new Date(2025, 0, 13, 11, 42).toISOString();
	const first = observeWeeklyUsage(undefined, { weeklyUsedPercent: 40, resetAt, now });
	assert.ok(first);
	assert.equal(first.status.usedWindowPercent, 0);
	assert.equal(first.ledger.lastWeeklyPercent, 40);
	assert.ok(first.status.allowancePercent > 0);
	assert.equal(first.status.remainingWindowPercent, first.status.allowancePercent);
	assert.equal(first.status.blocked, false);
	assert.equal(first.status.warningPending, false);
	const next = observeWeeklyUsage(first.ledger, { weeklyUsedPercent: 47, resetAt, now });
	assert.ok(next);
	assert.equal(next.status.usedWindowPercent, 7);
	assert.equal(next.status.allowancePercent, first.status.allowancePercent);
	const duplicate = observeWeeklyUsage(next.ledger, { weeklyUsedPercent: 47, resetAt, now });
	assert.ok(duplicate);
	assert.equal(duplicate.status.usedWindowPercent, 7);
	const lower = observeWeeklyUsage(duplicate.ledger, { weeklyUsedPercent: 42, resetAt, now });
	assert.ok(lower);
	assert.equal(lower.status.usedWindowPercent, 7);
});

test("keeps the current fixed window across a provider reset and starts fresh usage", () => {
	const first = observeWeeklyUsage(undefined, {
		weeklyUsedPercent: 99,
		resetAt: new Date(2025, 0, 6, 11, 42).toISOString(),
		now: new Date(2025, 0, 5, 22),
	});
	assert.ok(first);
	const nextReset = observeWeeklyUsage(first.ledger, {
		weeklyUsedPercent: 1,
		resetAt: new Date(2025, 0, 13, 11, 42).toISOString(),
		now: new Date(2025, 0, 6, 7),
	});
	assert.ok(nextReset);
	assert.equal(nextReset.status.usedWindowPercent, 0);
	assert.equal(nextReset.status.blocked, false);
});

test("migrates reset-anchored state without attributing historical usage to a new window", () => {
	const resetAt = new Date(2025, 0, 6, 11, 42).toISOString();
	const migrated = migratePacingLedger({
		version: 2,
		weekResetAt: resetAt,
		days: {
			[new Date(2025, 0, 5, 11, 42).toISOString()]: {
				allowancePercent: 20,
				usedPercent: 20,
				lastWeeklyPercent: 40,
				initialUsageAttributed: true,
			},
		},
	});
	assert.ok(migrated);
	assert.equal(migrated.version, 3);
	const result = observeWeeklyUsage(migrated, {
		weeklyUsedPercent: 40,
		resetAt,
		now: new Date(2025, 0, 6, 7),
	});
	assert.ok(result);
	assert.equal(result.status.usedWindowPercent, 0);
	assert.equal(result.status.blocked, false);
	const delta = observeWeeklyUsage(result.ledger, {
		weeklyUsedPercent: 43,
		resetAt,
		now: new Date(2025, 0, 6, 7),
	});
	assert.ok(delta);
	assert.equal(delta.status.usedWindowPercent, 3);
});

test("persists a migrated ledger in the version 3 format", () => {
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	const base = join(tmpdir(), `pi-pacing-${process.pid}-${Date.now()}`);
	const ledgerPath = join(base, "cache", "usage-status", "openai", "pacing.json");
	const resetAt = new Date(2025, 0, 6, 11, 42).toISOString();
	try {
		mkdirSync(join(base, "cache", "usage-status", "openai"), { recursive: true });
		writeFileSync(
			ledgerPath,
			JSON.stringify({
				version: 2,
				weekResetAt: resetAt,
				days: {
					old: { allowancePercent: 10, usedPercent: 10, lastWeeklyPercent: 35 },
				},
			}),
		);
		process.env.PI_CODING_AGENT_DIR = base;
		const loaded = loadPacingLedger();
		assert.ok(loaded);
		assert.equal(loaded.version, 3);
		assert.equal(JSON.parse(readFileSync(ledgerPath, "utf8")).version, 3);
	} finally {
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
	}
});

test("warns once per window and blocks at the weekly hard stop", () => {
	const resetAt = new Date(2025, 0, 13, 7).toISOString();
	const first = observeWeeklyUsage(undefined, {
		weeklyUsedPercent: 0,
		resetAt,
		now: new Date(2025, 0, 6, 7),
	});
	assert.ok(first);
	const nearLimit = observeWeeklyUsage(first.ledger, {
		weeklyUsedPercent: 9.5,
		resetAt,
		now: new Date(2025, 0, 6, 7),
	});
	assert.ok(nearLimit);
	assert.equal(nearLimit.status.warningPending, true);
	markPacingWarningSent(nearLimit.ledger, nearLimit.status.window ?? nearLimit.status.day);
	const afterWarning = observeWeeklyUsage(nearLimit.ledger, {
		weeklyUsedPercent: 5,
		resetAt,
		now: new Date(2025, 0, 6, 7),
	});
	assert.ok(afterWarning);
	assert.equal(afterWarning.status.warningPending, false);
	const stopped = observeWeeklyUsage(afterWarning.ledger, {
		weeklyUsedPercent: 100,
		resetAt,
		now: new Date(2025, 0, 6, 7),
	});
	assert.ok(stopped);
	assert.equal(stopped.status.blocked, true);
});

test("keeps local boundaries through DST changes", () => {
	const previousTz = process.env.TZ;
	process.env.TZ = "America/New_York";
	try {
		const spring = pacingWindow(new Date(2025, 2, 9, 6, 59));
		assert.deepEqual(spring.start, new Date(2025, 2, 8, 21));
		assert.deepEqual(spring.end, new Date(2025, 2, 9, 7));
		assert.equal(spring.end.getTime() - spring.start.getTime(), 9 * 60 * 60_000);
		const autumn = pacingWindow(new Date(2025, 10, 2, 6, 59));
		assert.deepEqual(autumn.start, new Date(2025, 10, 1, 21));
		assert.deepEqual(autumn.end, new Date(2025, 10, 2, 7));
		assert.equal(autumn.end.getTime() - autumn.start.getTime(), 11 * 60 * 60_000);
	} finally {
		if (previousTz === undefined) delete process.env.TZ;
		else process.env.TZ = previousTz;
	}
});
