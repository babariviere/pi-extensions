import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArguments } from "./pi-usage/index.ts";

test("parseArguments defaults to a daily report", () => {
	const options = parseArguments([]);
	assert.equal(options.kind, "daily");
	assert.ok(options.sessionsDir.endsWith("/.pi/agent/sessions"));
});

test("parseArguments accepts report filters", () => {
	const options = parseArguments([
		"monthly",
		"--since",
		"2026-09-01",
		"--until",
		"2026-09-30",
		"--timezone",
		"Europe/Paris",
		"--breakdown",
		"--json",
	]);
	assert.equal(options.kind, "monthly");
	assert.equal(options.since, "2026-09-01");
	assert.equal(options.until, "2026-09-30");
	assert.equal(options.timezone, "Europe/Paris");
	assert.equal(options.breakdown, true);
	assert.equal(options.json, true);
});

test("parseArguments rejects inverted dates", () => {
	assert.throws(() => parseArguments(["--since", "2026-09-02", "--until", "2026-09-01"]), /must not be after/);
});

test("parseArguments rejects impossible calendar dates", () => {
	assert.throws(() => parseArguments(["--since", "2026-02-31"]), /valid YYYY-MM-DD/);
});
