/**
 * Footer Extension
 *
 * A minimal footer that merges the old status-line + usage-status extensions:
 *
 *	 Line 1:	<context gauge>																					 <model> • <thinking>
 *	 Line 2:	Claude <5h bar %> <Week bar %> <extra> ⟳ <reset>		(Claude models only)
 *
 * Left side	→ context window usage + Claude subscription usage.
 * Right side → model id + thinking level.
 *
 * Claude usage data is not fetched here: the `usage` extension owns the poll
 * and publishes it on pi's event bus (`usage:snapshot`). This extension only
 * subscribes and renders.
 */

import type { ExtensionAPI, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	FIVE_HOUR_LABEL,
	USAGE_REQUEST_EVENT,
	USAGE_SNAPSHOT_EVENT,
	type UsageSnapshot,
	findWindow,
	isAnthropicModel,
	isUsageSnapshotEvent,
} from "../usage/protocol.ts";

// ── Context thresholds ──────────────────────────────────────────────────
const CONTEXT_WARNING_THRESHOLD = 70;
const CONTEXT_ERROR_THRESHOLD = 90;
const CTX_BAR_WIDTH = 12;

// Usage bar thresholds
const USAGE_WARNING_THRESHOLD = 85;
const USAGE_ERROR_THRESHOLD = 92;

// Thin bar glyphs
const BAR_FILLED = "━";
const BAR_EMPTY = "─";

// Anthropic brand orange (#D97757) as a 24-bit ANSI foreground escape.
const ORANGE = "\x1b[38;2;217;119;87m";
const RESET = "\x1b[0m";
const colorizeOrange = (text: string): string => `${ORANGE}${text}${RESET}`;

// ── Formatting helpers ──────────────────────────────────────────────────

/**
 * Sanitize text for display in a single-line status. Removes newlines, tabs,
 * carriage returns, and collapses repeated spaces.
 */
function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/** Formats a token count into a human-readable string. */
function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/** Compact "2h34m" until the timestamp, or undefined if past/invalid. */
function formatTimeLeft(resetsAt: string | undefined): string | undefined {
	if (!resetsAt) return undefined;
	const ms = new Date(resetsAt).getTime() - Date.now();
	if (!Number.isFinite(ms) || ms <= 0) return undefined;
	const totalMin = Math.round(ms / 60_000);
	const h = Math.floor(totalMin / 60);
	const m = totalMin % 60;
	return h > 0 ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m`;
}

function clampPercent(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(100, value));
}

/** Renders a thin filled/empty bar, colored by `colorFor(percent)`. */
function renderBar(percent: number, width: number, colorFor: (p: number) => ThemeColor, theme: Theme): string {
	const clamped = clampPercent(percent);
	const filled = Math.round((clamped / 100) * width);
	const empty = width - filled;
	return theme.fg(colorFor(clamped), BAR_FILLED.repeat(filled)) + theme.fg("dim", BAR_EMPTY.repeat(empty));
}

function contextColor(p: number): "error" | "warning" | "accent" | "success" {
	if (p >= CONTEXT_ERROR_THRESHOLD) return "error";
	if (p >= CONTEXT_WARNING_THRESHOLD) return "warning";
	if (p >= 50) return "accent";
	return "success";
}

function usageColor(p: number): "error" | "warning" | "success" {
	if (p >= USAGE_ERROR_THRESHOLD) return "error";
	if (p >= USAGE_WARNING_THRESHOLD) return "warning";
	return "success";
}

/** Build the left "context gauge" segment: `ctx ━━━━──── 42% 84k/200k`. */
function renderContextGauge(
	percent: number,
	used: number,
	total: number,
	theme: Theme,
	options?: { barWidth?: number; includeCounts?: boolean },
): string {
	const barWidth = Math.max(4, options?.barWidth ?? CTX_BAR_WIDTH);
	const bar = renderBar(percent, barWidth, contextColor, theme);
	const pct = `${Math.round(clampPercent(percent))}%`;
	const counts = options?.includeCounts === false || !total ? "" : ` ${formatTokens(used)}/${formatTokens(total)}`;
	return theme.fg("dim", "ctx ") + bar + " " + theme.fg("dim", pct + counts);
}

/** Build the Claude usage line: `Claude 5h ━━──── 30% Week ━──── 12% ⟳ 2h34m`. */
function renderUsageLine(snapshot: UsageSnapshot, theme: Theme): string {
	const dim = (s: string) => theme.fg("dim", s);

	if (snapshot.error) return colorizeOrange("Claude ") + dim(snapshot.error);
	if (snapshot.windows.length === 0) return "";

	const segments: string[] = [colorizeOrange("Claude")];

	for (const w of snapshot.windows) {
		if (w.label.startsWith("Extra")) {
			// "Extra [on]/[active] <used>/<limit>" -> "extra <used>/<limit>€"
			const value = w.label.replace(/^Extra\s*\[[^\]]*\]\s*/, "").trim();
			segments.push(dim("extra ") + `${value}€`);
			continue;
		}
		const bar = renderBar(w.usedPercent, 6, usageColor, theme);
		segments.push(`${dim(w.label)} ${bar} ${dim(`${Math.round(w.usedPercent)}%`)}`);
	}

	const timeLeft = formatTimeLeft(findWindow(snapshot, FIVE_HOUR_LABEL)?.resetsAt);
	if (timeLeft) segments.push(dim(`⟳ ${timeLeft}`));

	return segments.join(" ");
}

/** Build the right "model • thinking" segment. */
function renderModel(
	pi: ExtensionAPI,
	ctx: { model?: { id?: string; provider?: string; reasoning?: unknown } },
	showProvider: boolean,
	theme: Theme,
): string {
	const modelName = ctx.model?.id?.split("/").pop() || "no-model";
	let str = theme.fg("muted", modelName);

	if (ctx.model && showProvider && ctx.model.provider) {
		str = theme.fg("dim", `(${ctx.model.provider}) `) + str;
	}

	if (ctx.model?.reasoning) {
		const thinkingLevel = pi.getThinkingLevel() || "off";
		str += " " + theme.fg("dim", "•") + " ";
		str += thinkingLevel === "off" ? theme.fg("dim", "thinking off") : theme.fg("accent", thinkingLevel);
	}

	return str;
}

/** Home-collapsed current working directory, e.g. `~/code/project`. */
function formatProject(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (home && cwd.startsWith(home)) return `~${cwd.slice(home.length)}`;
	return cwd;
}

/**
 * Fish-style path abbreviation: shorten every component except the last to its
 * first character (keeping a leading dot for hidden dirs), e.g.
 * `~/src/github.com/acme/widgets` -> `~/s/g/a/widgets`.
 */
function abbreviatePath(path: string): string {
	const parts = path.split("/");
	if (parts.length <= 1) return path;
	const last = parts.length - 1;
	return parts
		.map((part, i) => {
			if (i === last || part === "" || part === "~") return part;
			if (part.startsWith(".")) return part.slice(0, 2);
			return part.slice(0, 1);
		})
		.join("/");
}

/** Truncate a path from the left, keeping its (more meaningful) tail. */
function truncatePathTail(path: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	if (path.length <= maxWidth) return path;
	if (maxWidth === 1) return "\u2026";
	return "\u2026" + path.slice(-(maxWidth - 1));
}

/** Lay out a left and right segment on a single line, right-aligned. */
function layoutLine(left: string, right: string, width: number): string {
	const leftW = visibleWidth(left);
	const rightW = visibleWidth(right);
	const minGap = 2;

	if (leftW + minGap + rightW <= width) {
		return left + " ".repeat(width - leftW - rightW) + right;
	}

	// Right segment is the priority (model • thinking): keep it whole, truncate
	// the left to fit. If even the right alone is too wide, truncate the right.
	const availableForLeft = width - minGap - rightW;
	if (availableForLeft > 0) {
		const truncatedLeft = truncateToWidth(left, availableForLeft, "");
		const tW = visibleWidth(truncatedLeft);
		return truncatedLeft + " ".repeat(Math.max(0, width - tW - rightW)) + right;
	}
	return truncateToWidth(right, width, "");
}

// ── Extension ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
	let tuiRef: { requestRender: () => void } | null = null;
	let footerDisposeRef: (() => void) | null = null;

	// Claude usage state, fed by the `usage` extension over the event bus.
	let usageSnapshot: UsageSnapshot | undefined;
	let lastModel: { provider?: string; id?: string } | undefined;

	pi.events.on(USAGE_SNAPSHOT_EVENT, (data) => {
		if (!isUsageSnapshotEvent(data)) return;
		usageSnapshot = data.snapshot.windows.length > 0 ? data.snapshot : undefined;
		tuiRef?.requestRender();
	});

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		lastModel = ctx.model;

		// Clean up any previous footer to prevent leaks.
		footerDisposeRef?.();
		footerDisposeRef = null;

		ctx.ui.setFooter((tui, theme, footerData) => {
			tuiRef = tui;

			// The bus has no replay, so ask the usage extension for its current value.
			pi.events.emit(USAGE_REQUEST_EVENT, { reason: "footer" });

			const dispose = () => {
				tuiRef = null;
			};
			footerDisposeRef = dispose;

			return {
				dispose,
				invalidate(): void {},
				render(width: number): string[] {
					// Context usage
					const contextUsage = ctx.getContextUsage();
					const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const percent = contextUsage?.percent ?? 0;
					const used = contextUsage?.tokens ?? Math.round((percent / 100) * contextWindow);

					const contextSegment = renderContextGauge(percent, used, contextWindow, theme);
					const modelSegment = renderModel(pi, ctx, footerData.getAvailableProviderCount() > 1, theme);

					// Build the left side: project path + context gauge. The project
					// path is the expendable part, so reserve space for the context
					// gauge and model first, then truncate the path tail into whatever
					// room is left (keeping context + model fully visible).
					const ctxGap = 2;
					const modelGap = 2;
					const reserved = visibleWidth(contextSegment) + modelGap + visibleWidth(modelSegment);
					const projectRaw = abbreviatePath(formatProject(ctx.cwd));
					const projectAvail = width - reserved - ctxGap;
					const projectShown = truncatePathTail(projectRaw, Math.max(0, projectAvail));
					const leftSegment = projectShown
						? `${theme.fg("accent", projectShown)}${" ".repeat(ctxGap)}${contextSegment}`
						: contextSegment;

					const lines: string[] = [layoutLine(leftSegment, modelSegment, width)];

					if (usageSnapshot && isAnthropicModel(ctx.model ?? lastModel)) {
						const usageLine = renderUsageLine(usageSnapshot, theme);
						if (usageLine) lines.push(truncateToWidth(usageLine, width, theme.fg("dim", "...")));
					}

					// Extension statuses (set by other extensions via ctx.ui.setStatus),
					// sorted by key alphabetically and joined on a single line.
					const extensionStatuses = footerData.getExtensionStatuses();
					if (extensionStatuses.size > 0) {
						const statusLine = Array.from(extensionStatuses.entries())
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([, text]) => sanitizeStatusText(text))
							.join(" ");
						if (statusLine) lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
					}

					return lines;
				},
			};
		});
	});

	pi.on("model_select", async (event, ctx) => {
		lastModel = event.model ?? ctx.model;
		tuiRef?.requestRender();
	});

	pi.on("session_shutdown", async () => {
		footerDisposeRef?.();
		footerDisposeRef = null;
	});
}
