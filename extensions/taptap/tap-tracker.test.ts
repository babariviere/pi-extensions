import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TapTracker } from "./tap-tracker.ts";

describe("TapTracker", () => {
	it("arms on the first tap", () => {
		const tracker = new TapTracker(600);
		assert.equal(tracker.tap(1000), "arm");
		assert.equal(tracker.armed, true);
	});

	it("fires on a second tap inside the window", () => {
		const tracker = new TapTracker(600);
		tracker.tap(1000);
		assert.equal(tracker.tap(1400), "fire");
		assert.equal(tracker.armed, false);
	});

	it("re-arms instead of firing outside the window", () => {
		const tracker = new TapTracker(600);
		tracker.tap(1000);
		assert.equal(tracker.tap(1600), "arm");
		assert.equal(tracker.tap(1900), "fire");
	});

	it("does not fire twice on a triple tap", () => {
		const tracker = new TapTracker(600);
		assert.equal(tracker.tap(1000), "arm");
		assert.equal(tracker.tap(1100), "fire");
		assert.equal(tracker.tap(1200), "arm");
		assert.equal(tracker.tap(1300), "fire");
	});

	it("forgets the armed tap after reset", () => {
		const tracker = new TapTracker(600);
		tracker.tap(1000);
		tracker.reset();
		assert.equal(tracker.armed, false);
		assert.equal(tracker.tap(1100), "arm");
	});
});
