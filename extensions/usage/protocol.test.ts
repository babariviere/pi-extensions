import assert from "node:assert/strict";
import test from "node:test";
import { isUsagePacingEvent } from "./protocol.ts";

test("recognizes published pacing state and a cleared pacing state", () => {
	assert.equal(
		isUsagePacingEvent({
			pacing: {
				weekResetAt: "2025-01-02T00:00:00.000Z",
				weeklyUsedPercent: 30,
				day: "2025-01-01",
				daysRemaining: 2,
				allowancePercent: 35,
				usedTodayPercent: 30,
				remainingTodayPercent: 5,
				blocked: false,
			},
		}),
		true,
	);
	assert.equal(isUsagePacingEvent({ enforced: false }), true);
	assert.equal(isUsagePacingEvent({}), true);
});

test("rejects malformed pacing events", () => {
	assert.equal(isUsagePacingEvent(undefined), false);
	assert.equal(isUsagePacingEvent({ pacing: { blocked: "no", remainingTodayPercent: 0 } }), false);
	assert.equal(isUsagePacingEvent({ pacing: { blocked: true, remainingTodayPercent: "none" } }), false);
	assert.equal(isUsagePacingEvent({ enforced: "no" }), false);
});
