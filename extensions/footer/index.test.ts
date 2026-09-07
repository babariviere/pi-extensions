import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderUsageLine } from "./index.ts";
import type { UsagePacingEvent } from "../usage/protocol.ts";

const plainTheme = {
	fg: (_color: unknown, text: string) => text,
} as Theme;

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

test("renders Codex in blue with its weekly reset", () => {
	const resetsAt = new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString();
	const rendered = renderUsageLine(
		{
			provider: "openai",
			windows: [{ label: "Week", usedPercent: 12, resetsAt }],
		},
		plainTheme,
	);

	assert.match(rendered, /^\x1b\[38;2;59;130;246mCodex\x1b\[0m /);
	assert.match(stripAnsi(rendered), /Week .* 12% ⟳ Week 7d0h$/);
});

test("renders Codex pacing state", () => {
	const snapshot = { provider: "openai" as const, windows: [] };
	const pacing = {
		enforced: true,
		pacing: {
			weekResetAt: "2025-01-02T00:00:00.000Z",
			day: "2025-01-01T00:00:00.000Z",
			weeklyUsedPercent: 42,
			daysRemaining: 3,
			allowancePercent: 60,
			usedTodayPercent: 42,
			remainingTodayPercent: 18,
			blocked: false,
			warningPending: false,
		},
	} satisfies UsagePacingEvent;
	assert.equal(stripAnsi(renderUsageLine(snapshot, plainTheme, pacing)), "Codex pace:on 42/60%");
	const disabledUntil = new Date();
	disabledUntil.setHours(21, 0, 0, 0);
	assert.equal(
		stripAnsi(
			renderUsageLine(snapshot, plainTheme, {
				enforced: false,
				disabledUntil: disabledUntil.toISOString(),
			}),
		),
		`Codex pace:off →${String(disabledUntil.getHours()).padStart(2, "0")}:00`,
	);
	assert.equal(
		stripAnsi(
			renderUsageLine(snapshot, plainTheme, {
				...pacing,
				pacing: { ...pacing.pacing, blocked: true },
			}),
		),
		"Codex pace:blocked 42/60%",
	);
});
