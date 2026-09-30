import assert from "node:assert/strict";
import { test } from "node:test";
import { CauseBreaker, causeSignature } from "./cause-breaker.ts";

test("causeSignature collapses the ids that vary between identical failures", () => {
	const first = causeSignature(
		"timed out waiting for agent startup (pane w2J:p3D, transcript /a/b/2026-09-02T18-57-59-849Z_f6duc1/task-0.session.jsonl)",
	);
	const second = causeSignature(
		"timed out waiting for agent startup (pane w2J:p9Z, transcript /a/b/2026-09-02T20-11-25-521Z_z91gkp/task-0.session.jsonl)",
	);
	assert.equal(first, second, "two occurrences of one fault must count as one cause");
	assert.notEqual(first, causeSignature("unsupported interactive agent kind foo"));
});

test("the circuit opens on the third identical failure, not before", () => {
	const breaker = new CauseBreaker({ limit: 3, now: () => 1000 });
	breaker.record("timed out waiting for agent startup (pane wA:p1)");
	assert.equal(breaker.verdict(), undefined);
	breaker.record("timed out waiting for agent startup (pane wA:p2)");
	assert.equal(breaker.verdict(), undefined);
	breaker.record("timed out waiting for agent startup (pane wA:p3)");
	const verdict = breaker.verdict();
	assert.equal(verdict?.count, 3);
	assert.match(verdict?.error ?? "", /waiting for agent startup/);
});

test("a different cause restarts the count instead of adding to it", () => {
	const breaker = new CauseBreaker({ limit: 3, now: () => 1000 });
	breaker.record("timed out waiting for agent startup");
	breaker.record("timed out waiting for agent startup");
	breaker.record("unsupported interactive agent kind foo");
	assert.equal(breaker.verdict(), undefined);
});

test("anything that works clears the circuit", () => {
	const breaker = new CauseBreaker({ limit: 2, now: () => 1000 });
	breaker.record("boom");
	breaker.record("boom");
	assert.ok(breaker.verdict());
	breaker.clear();
	assert.equal(breaker.verdict(), undefined);
});

test("the circuit is half-open: one attempt gets through after the retry window", () => {
	let now = 1000;
	const breaker = new CauseBreaker({ limit: 2, retryAfterMs: 60_000, now: () => now });
	breaker.record("boom");
	breaker.record("boom");
	assert.ok(breaker.verdict(), "open while the window holds");

	now += 60_000;
	assert.equal(breaker.verdict(), undefined, "one probe is allowed once the window elapses");
	assert.equal(breaker.verdict(), undefined, "and it stays closed until that probe reports");

	breaker.record("boom");
	assert.ok(breaker.verdict(), "a failed probe re-opens it at once");
});
