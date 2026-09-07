import assert from "node:assert/strict";
import test from "node:test";
import { formatLocalDateTime } from "./format.ts";

test("formats timestamps in the selected local time zone", () => {
	const timestamp = "2027-01-15T08:00:00.000Z";
	const paris = formatLocalDateTime(timestamp, { locale: "en-US", timeZone: "Europe/Paris" });
	const newYork = formatLocalDateTime(timestamp, { locale: "en-US", timeZone: "America/New_York" });

	assert.match(paris, /Jan 15, 2027/);
	assert.match(paris, /9:00 AM/);
	assert.match(newYork, /Jan 15, 2027/);
	assert.match(newYork, /3:00 AM/);
	assert.notEqual(paris, newYork);
});

test("preserves an invalid timestamp", () => {
	assert.equal(formatLocalDateTime("unknown"), "unknown");
});
