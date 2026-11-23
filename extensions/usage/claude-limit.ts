import timers from "node:timers/promises";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatLocalDateTime } from "./format.ts";
import { FIVE_HOUR_LABEL, findWindow, type UsageSnapshot, WEEK_LABEL } from "./protocol.ts";
import { REFRESH_INTERVAL_MS } from "./source.ts";

function exhaustedWindow(snapshot: UsageSnapshot | undefined, now: number) {
	if (snapshot?.provider !== "anthropic" || snapshot.error) return;
	for (const label of [WEEK_LABEL, FIVE_HOUR_LABEL]) {
		const window = findWindow(snapshot, label);
		if (!window || !(window.usedPercent >= 100)) continue;
		const reset = Date.parse(window.resetsAt ?? "");
		if (!Number.isFinite(reset) || reset > now) return { label, reset };
	}
}

/** Hold the pending request, not the prompt or transcript. Esc cancels the wait. */
export async function waitForClaudeUsage(ctx: ExtensionContext, currentUsage: () => UsageSnapshot | undefined) {
	const { model, signal } = ctx;
	if (!signal || model?.provider !== "anthropic" || !ctx.modelRegistry.isUsingOAuth(model)) return;
	// Embedded hosts already own the pause policy, including their Force work override.
	if (process.env.PILOT_SUBSCRIPTION_POLICY) return;

	let status: string | undefined;
	try {
		while (!signal.aborted) {
			const now = Date.now();
			const limit = exhaustedWindow(currentUsage(), now);
			if (!limit) return;
			const resetKnown = Number.isFinite(limit.reset);
			const label = limit.label === WEEK_LABEL ? "weekly" : limit.label;
			const next = `Claude paused: ${label} limit reached${resetKnown ? `, resets ${formatLocalDateTime(new Date(limit.reset).toISOString())}` : ""}`;
			if (ctx.hasUI && status !== next) {
				status = next;
				ctx.ui.setStatus("claude-limit", status);
				ctx.ui.notify(`${status}. Press Esc to cancel.`, "warning");
			}
			await timers.setTimeout(
				resetKnown ? Math.min(limit.reset - now, REFRESH_INTERVAL_MS) : REFRESH_INTERVAL_MS,
				undefined,
				{
					signal,
				},
			);
		}
	} catch (error) {
		if (!signal.aborted) throw error;
	} finally {
		if (status) ctx.ui.setStatus("claude-limit", undefined);
	}
}
