import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scheduledStartAt } from "./schedule.ts";

describe("scheduledStartAt", () => {
	for (const hour of [0, 2, 9, 20]) {
		it(`waits until today at 21:00 when approved at ${hour}:59`, () => {
			assert.equal(scheduledStartAt(new Date(2026, 7, 29, hour, 59)), new Date(2026, 7, 29, 21).getTime());
		});
	}
	for (const hour of [21, 22, 23]) {
		it(`starts immediately at ${hour}:00`, () => {
			const now = new Date(2026, 7, 29, hour);
			assert.equal(scheduledStartAt(now), now.getTime());
		});
	}
	it("does not mutate the approval time", () => {
		const now = new Date(2026, 7, 29, 20, 59, 59, 999);
		const original = now.getTime();
		assert.equal(scheduledStartAt(now), original + 1);
		assert.equal(now.getTime(), original);
	});
});
