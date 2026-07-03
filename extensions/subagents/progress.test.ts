import assert from "node:assert/strict";
import { test } from "node:test";
import { type AgentProgress, applyStatus, formatElapsed, renderProgress, SPINNER_FRAMES, stateGlyph } from "./tool.ts";

test("formatElapsed formats sub-minute and minute durations", () => {
	assert.equal(formatElapsed(-500), "0s");
	assert.equal(formatElapsed(0), "0s");
	assert.equal(formatElapsed(5_400), "5s");
	assert.equal(formatElapsed(59_999), "59s");
	assert.equal(formatElapsed(60_000), "1m00s");
	assert.equal(formatElapsed(75_000), "1m15s");
	assert.equal(formatElapsed(605_000), "10m05s");
});

test("renderProgress shows a spinner glyph, state, elapsed, pane and output per agent", () => {
	const now = 100_000;
	const model: AgentProgress[] = [
		{ name: "worker", scope: "user", state: "running", startedAt: now - 75_000, paneId: "wA:p3", outputPath: "/tmp/out/worker_0.md" },
		{ name: "reviewer", scope: "user", state: "spawning", startedAt: now },
	];
	const text = renderProgress(model, now);
	assert.equal(
		text,
		[
			"Running 2 subagents (2 active):",
			`- ${SPINNER_FRAMES[0]} worker [running] \u00b7 1m15s \u00b7 pane wA:p3 \u00b7 output: /tmp/out/worker_0.md`,
			`- ${SPINNER_FRAMES[0]} reviewer [spawning] \u00b7 0s`,
		].join("\n"),
	);
});

test("renderProgress uses singular noun, terminal header and a check glyph when done", () => {
	const now = 10_000;
	const model: AgentProgress[] = [
		{ name: "worker", scope: "project", state: "done", startedAt: now - 3_000, outputPath: "/tmp/out.md" },
	];
	const text = renderProgress(model, now);
	assert.equal(
		text,
		["Subagents (1):", "- \u2713 worker [done] \u00b7 3s \u00b7 output: /tmp/out.md"].join("\n"),
	);
});

test("renderProgress marks failed runs with a cross glyph and uppercase label", () => {
	const now = 5_000;
	const model: AgentProgress[] = [
		{ name: "worker", scope: "user", state: "failed", startedAt: now - 1_000 },
	];
	assert.equal(renderProgress(model, now), ["Subagents (1):", "- \u2717 worker [FAILED] \u00b7 1s"].join("\n"));
});

test("renderProgress freezes elapsed at endedAt for terminal rows", () => {
	const model: AgentProgress[] = [
		{ name: "worker", scope: "user", state: "done", startedAt: 0, endedAt: 3_000, outputPath: "/tmp/out.md" },
	];
	// now advances far past endedAt, but elapsed must stay frozen at 3s.
	assert.equal(renderProgress(model, 999_000), ["Subagents (1):", "- \u2713 worker [done] \u00b7 3s \u00b7 output: /tmp/out.md"].join("\n"));
});

test("renderProgress advances the spinner frame by injected index", () => {
	const model: AgentProgress[] = [{ name: "worker", scope: "user", state: "running", startedAt: 0 }];
	assert.ok(renderProgress(model, 1_000, { frame: 3 }).includes(SPINNER_FRAMES[3]));
	// wraps around the frame array
	assert.ok(renderProgress(model, 1_000, { frame: SPINNER_FRAMES.length + 2 }).includes(SPINNER_FRAMES[2]));
});

test("stateGlyph picks spinner for active states and check/cross for terminal", () => {
	assert.equal(stateGlyph("done", 0), "\u2713");
	assert.equal(stateGlyph("failed", 0), "\u2717");
	assert.equal(stateGlyph("running", 1), SPINNER_FRAMES[1]);
	assert.equal(stateGlyph("spawning", 0), SPINNER_FRAMES[0]);
});

test("renderProgress can wrap terminal glyphs in ANSI color when requested", () => {
	const model: AgentProgress[] = [{ name: "worker", scope: "user", state: "done", startedAt: 0, endedAt: 1_000 }];
	assert.ok(renderProgress(model, 1_000, { color: true }).includes("\u001b[32m\u2713\u001b[0m"));
	// default (no color) leaves the glyph bare
	assert.ok(!renderProgress(model, 1_000).includes("\u001b["));
});

test("renderProgress wraps active spinner glyphs in orange when color requested", () => {
	const model: AgentProgress[] = [{ name: "worker", scope: "user", state: "running", startedAt: 0 }];
	assert.ok(renderProgress(model, 1_000, { frame: 0, color: true }).includes(`\u001b[38;5;208m${SPINNER_FRAMES[0]}\u001b[0m`));
	// spawning is also active and orange
	const spawning: AgentProgress[] = [{ name: "reviewer", scope: "user", state: "spawning", startedAt: 0 }];
	assert.ok(renderProgress(spawning, 1_000, { frame: 0, color: true }).includes(`\u001b[38;5;208m${SPINNER_FRAMES[0]}\u001b[0m`));
});

test("applyStatus updates the row at the given index and preserves others", () => {
	const model: AgentProgress[] = [
		{ name: "worker", scope: "user", state: "spawning", startedAt: 0 },
		{ name: "reviewer", scope: "user", state: "spawning", startedAt: 0 },
	];
	applyStatus(model, 1, { state: "running", paneId: "wA:p9", outputPath: "/tmp/r.md" });
	assert.deepEqual(model[0], { name: "worker", scope: "user", state: "spawning", startedAt: 0 });
	assert.deepEqual(model[1], {
		name: "reviewer",
		scope: "user",
		state: "running",
		startedAt: 0,
		paneId: "wA:p9",
		outputPath: "/tmp/r.md",
	});
});

test("applyStatus stamps endedAt once on a terminal transition and not for active states", () => {
	const model: AgentProgress[] = [{ name: "worker", scope: "user", state: "running", startedAt: 0 }];
	applyStatus(model, 0, { state: "running" }, 1_000);
	assert.equal(model[0].endedAt, undefined);
	applyStatus(model, 0, { state: "done" }, 5_000);
	assert.equal(model[0].endedAt, 5_000);
	// a later terminal update must not overwrite the first stamp
	applyStatus(model, 0, { state: "failed" }, 9_000);
	assert.equal(model[0].endedAt, 5_000);
});

test("applyStatus ignores an out-of-range index", () => {
	const model: AgentProgress[] = [{ name: "worker", scope: "user", state: "spawning", startedAt: 0 }];
	applyStatus(model, 5, { state: "done" });
	assert.equal(model[0].state, "spawning");
});
