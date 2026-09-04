/**
 * Single owner of subscription-usage polls. Claude and Codex / ChatGPT OAuth
 * usage are cached per provider and republished on pi's event bus.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	FIVE_HOUR_LABEL,
	USAGE_PACING_EVENT,
	USAGE_REQUEST_EVENT,
	USAGE_SNAPSHOT_EVENT,
	WEEK_LABEL,
	findWindow,
	isOpenAIModel,
	type UsageProvider,
	type UsageSnapshot,
	type UsageSnapshotEvent,
	usageProviderForModel,
} from "./protocol.ts";
import {
	CODEX_PACING_WARNING_PERCENT,
	loadPacingLedger,
	markPacingWarningSent,
	observeWeeklyUsage,
	savePacingLedger,
	type PacingStatus,
} from "./pacing.ts";
import {
	fetchWithCache,
	isOAuthToken,
	loadClaudeToken,
	loadOpenAIToken,
	REFRESH_INTERVAL_MS,
	readCache,
	watchCache,
} from "./source.ts";

const UNAVAILABLE: UsageSnapshot = { windows: [] };

const percent = (value: number | undefined): string => (value === undefined ? "unknown" : `${value.toFixed(1)}%`);

export default function (pi: ExtensionAPI): void {
	let last: UsageSnapshotEvent | undefined;
	let inFlight = false;
	let timer: ReturnType<typeof setInterval> | undefined;
	let stopWatch: (() => void) | undefined;
	let watchedProvider: UsageProvider | undefined;
	let model: { provider?: string; id?: string } | undefined;
	let pacingLedger = loadPacingLedger();
	let pacing: PacingStatus | undefined;
	let pacingEnabled = process.env.PI_USAGE_PACING !== "off";
	let pacingOverride = false;

	function provider(): UsageProvider | undefined {
		return usageProviderForModel(model);
	}

	function updatePacing(snapshot: UsageSnapshot): void {
		if (snapshot.provider !== "openai") {
			pacing = undefined;
			return;
		}
		const week = findWindow(snapshot, WEEK_LABEL);
		if (week?.usedPercent === undefined || !week.resetsAt) {
			pacing = undefined;
			return;
		}
		const observed = observeWeeklyUsage(pacingLedger, {
			weeklyUsedPercent: week.usedPercent,
			resetAt: week.resetsAt,
			now: new Date(),
		});
		if (!observed) return;
		pacingLedger = observed.ledger;
		pacing = observed.status;
		savePacingLedger(pacingLedger);
	}

	function publish(snapshot: UsageSnapshot, fetchedAt = Date.now()): void {
		updatePacing(snapshot);
		last = { fetchedAt, snapshot };
		pi.events.emit(USAGE_SNAPSHOT_EVENT, last);
		pi.events.emit(USAGE_PACING_EVENT, { ...(pacing ? { pacing } : {}) });
	}

	function syncWatch(): void {
		const next = provider();
		if (next === watchedProvider) return;
		stopWatch?.();
		stopWatch = undefined;
		watchedProvider = next;
		if (next) stopWatch = watchCache(next, (entry) => publish(entry.snapshot, entry.fetchedAt));
	}

	async function refresh(): Promise<void> {
		if (inFlight) return;
		const source = provider();
		syncWatch();
		if (!source) {
			if (last?.snapshot.windows.length) publish(UNAVAILABLE);
			return;
		}
		const token = source === "anthropic" ? loadClaudeToken() : loadOpenAIToken();
		if (!token || (source === "anthropic" && !isOAuthToken(token))) {
			if (last?.snapshot.windows.length) publish(UNAVAILABLE);
			return;
		}

		inFlight = true;
		try {
			const snapshot = await fetchWithCache(source, token);
			if (snapshot) publish(snapshot);
		} finally {
			inFlight = false;
		}
	}

	function seedFromCache(): void {
		if (last) return;
		const source = provider();
		const entry = source ? readCache(source) : undefined;
		if (entry?.snapshot && !entry.snapshot.error) publish(entry.snapshot, entry.fetchedAt);
	}

	function start(): void {
		if (!timer) {
			timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
			timer.unref?.();
		}
		syncWatch();
	}

	function stop(): void {
		if (timer) clearInterval(timer);
		timer = undefined;
		stopWatch?.();
		stopWatch = undefined;
		watchedProvider = undefined;
	}

	pi.events.on(USAGE_REQUEST_EVENT, () => {
		if (last) pi.events.emit(USAGE_SNAPSHOT_EVENT, last);
		else void refresh();
	});

	pi.on("session_start", async (_event, ctx) => {
		model = ctx.model;
		seedFromCache();
		if (last) pi.events.emit(USAGE_SNAPSHOT_EVENT, last);
		start();
		await refresh();
	});

	pi.on("model_select", async (event, ctx) => {
		model = event.model ?? ctx.model;
		await refresh();
	});

	pi.on("session_before_switch", async (event, ctx) => {
		if (event.reason === "new") {
			model = ctx.model;
			await refresh();
		}
	});

	pi.on("tool_call", (_event, ctx) => {
		if (!pacingEnabled || pacingOverride || !isOpenAIModel(ctx.model) || !pacing) return;
		if (pacing.warningPending) {
			markPacingWarningSent(pacingLedger, pacing.day);
			pacing.warningPending = false;
			if (pacingLedger) savePacingLedger(pacingLedger);
			pi.sendUserMessage(
				`[usage] Warning: you have used ${percent(pacing.usedTodayPercent)} of today's Codex pacing allowance ` +
					`(${percent(pacing.remainingTodayPercent)} remains). You are at the ${CODEX_PACING_WARNING_PERCENT}% warning threshold. ` +
					"Finish or checkpoint current work and avoid starting expensive new work before the allowance is exhausted.",
				{ deliverAs: "followUp" },
			);
		}
		if (!pacing.blocked) return;
		const reason =
			pacing.weeklyUsedPercent >= 100
				? "the Codex weekly limit is exhausted"
				: "today's Codex pacing allowance is exhausted";
		return {
			block: true,
			terminate: true,
			reason:
				`usage: ${reason} (${percent(pacing.usedTodayPercent)} used today, ` +
				`${percent(pacing.remainingTodayPercent)} remaining). Use /usage override to continue for this session.`,
		};
	});

	pi.registerCommand("usage", {
		description: "Show Codex subscription usage and weekly pacing (status | pacing on|off | override)",
		getArgumentCompletions: (prefix) =>
			["status", "pacing on", "pacing off", "override"]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "pacing on") {
				pacingEnabled = true;
				pacingOverride = false;
				ctx.ui.notify("usage: Codex pacing enabled", "info");
				return;
			}
			if (action === "pacing off") {
				pacingEnabled = false;
				ctx.ui.notify("usage: Codex pacing disabled for this session", "warning");
				return;
			}
			if (action === "override") {
				pacingOverride = true;
				ctx.ui.notify("usage: Codex pacing override enabled for this session", "warning");
				return;
			}
			const week = findWindow(last?.snapshot, WEEK_LABEL);
			const fiveHour = findWindow(last?.snapshot, FIVE_HOUR_LABEL);
			ctx.ui.notify(
				[
					`usage provider: ${last?.snapshot.provider ?? "unknown"}`,
					`Codex week: ${percent(week?.usedPercent)}${week?.resetsAt ? `, resets ${week.resetsAt}` : ""}`,
					`Codex 5h: ${fiveHour ? percent(fiveHour.usedPercent) : "none"} (informational)`,
					`pacing: ${pacingEnabled ? (pacingOverride ? "overridden for this session" : "enabled") : "disabled for this session"}`,
					...(pacing
						? [
								`today (${pacing.day}): ${percent(pacing.usedTodayPercent)} used of ${percent(pacing.allowancePercent)}, ${percent(pacing.remainingTodayPercent)} remaining`,
								`days through reset: ${pacing.daysRemaining}`,
								`blocked: ${pacing.blocked ? "yes" : "no"}`,
							]
						: ["today's pacing: unavailable until Codex weekly usage and reset are available"]),
				].join("\n"),
				"info",
			);
		},
	});

	pi.on("session_shutdown", async () => stop());
}
