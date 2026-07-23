/**
 * Pure renderer for the subagent live indicator. All functions are
 * deterministic given their inputs (`now`/`frame` are injected), so the
 * indicator can be tested without spawning anything. The tool owns the ticker
 * and the progress model; this module just turns that model into text.
 */

import { type RunState, type RunStatusUpdate } from "./run.ts";

/** Per-agent live progress row for the in-progress indicator. */
export interface AgentProgress {
	name: string;
	scope: string;
	state: RunState;
	startedAt: number;
	/** Stamped when the row reaches a terminal state so its elapsed freezes. */
	endedAt?: number;
	paneId?: string;
	outputPath?: string;
}

const STATE_LABEL: Record<RunState, string> = {
	spawning: "spawning",
	running: "running",
	done: "done",
	failed: "FAILED",
};

/** Braille spinner frames for active rows; advanced by the caller each tick. */
export const SPINNER_FRAMES = ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"];
const ANSI = { green: "\u001b[32m", red: "\u001b[31m", orange: "\u001b[38;5;208m", reset: "\u001b[0m" };

/** Status glyph for a row: spinner while active, check/cross when terminal. */
export function stateGlyph(state: RunState, frame: number): string {
	if (state === "done") return "\u2713";
	if (state === "failed") return "\u2717";
	return SPINNER_FRAMES[((frame % SPINNER_FRAMES.length) + SPINNER_FRAMES.length) % SPINNER_FRAMES.length];
}

/** Format an elapsed duration compactly: "5s", "1m05s". */
export function formatElapsed(ms: number): string {
	const clamped = ms > 0 ? ms : 0;
	const totalSec = Math.floor(clamped / 1000);
	if (totalSec < 60) return `${totalSec}s`;
	const min = Math.floor(totalSec / 60);
	const sec = totalSec % 60;
	return `${min}m${String(sec).padStart(2, "0")}s`;
}

/**
 * Pure renderer for the live indicator. `now` and `frame` are injected so callers
 * (and tests) control elapsed time and the spinner deterministically. Terminal
 * rows freeze their elapsed at `endedAt`. `color` opt-in wraps terminal glyphs in
 * ANSI (best-effort; ignored/stripped harmlessly when the view is plain text).
 */
export function renderProgress(
	model: AgentProgress[],
	now: number,
	opts: { frame?: number; color?: boolean } = {},
): string {
	const frame = opts.frame ?? 0;
	const active = model.filter((m) => m.state === "spawning" || m.state === "running").length;
	const noun = model.length === 1 ? "subagent" : "subagents";
	const header = active > 0
		? `Running ${model.length} ${noun} (${active} active):`
		: `Subagents (${model.length}):`;
	const lines = [header];
	for (const m of model) {
		const elapsed = formatElapsed((m.endedAt ?? now) - m.startedAt);
		const parts = [`[${STATE_LABEL[m.state]}]`, elapsed];
		if (m.paneId) parts.push(`pane ${m.paneId}`);
		if (m.outputPath) parts.push(`output: ${m.outputPath}`);
		lines.push(`- ${colorGlyph(stateGlyph(m.state, frame), m.state, opts.color)} ${m.name} ${parts.join(" \u00b7 ")}`);
	}
	return lines.join("\n");
}

function colorGlyph(glyph: string, state: RunState, color: boolean | undefined): string {
	if (!color) return glyph;
	if (state === "done") return `${ANSI.green}${glyph}${ANSI.reset}`;
	if (state === "failed") return `${ANSI.red}${glyph}${ANSI.reset}`;
	if (state === "spawning" || state === "running") return `${ANSI.orange}${glyph}${ANSI.reset}`;
	return glyph;
}

/**
 * Apply a status update to the progress row at `index` (mutates in place). When
 * the row reaches a terminal state, stamp `endedAt` (once) so its elapsed stops.
 */
export function applyStatus(model: AgentProgress[], index: number, update: RunStatusUpdate, now = Date.now()): void {
	const row = model[index];
	if (!row) return;
	row.state = update.state;
	if (update.paneId !== undefined) row.paneId = update.paneId;
	if (update.outputPath !== undefined) row.outputPath = update.outputPath;
	if ((update.state === "done" || update.state === "failed") && row.endedAt === undefined) {
		row.endedAt = now;
	}
}
