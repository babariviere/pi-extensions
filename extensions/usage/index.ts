/**
 * Single owner of subscription-usage polls. Claude and Codex / ChatGPT OAuth
 * usage are cached per provider and republished on pi's event bus.
 */

import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { formatLocalDateTime } from "./format.ts";
import {
	FIVE_HOUR_LABEL,
	USAGE_REQUEST_EVENT,
	USAGE_SNAPSHOT_EVENT,
	WEEK_LABEL,
	findWindow,
	type UsageProvider,
	type UsageSnapshot,
	type UsageSnapshotEvent,
	usageProviderForModel,
} from "./protocol.ts";
import {
	latestRoutedPhysicalModel,
	routedPhysicalModelFromMessage,
	type RoutedPhysicalModel,
} from "../shared/routed-model.ts";
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

type ModelRef = { provider?: string; id?: string; api?: string } | undefined;

/** Tracks the selected model separately from the last physical model on the active branch. */
export class UsageModelTracker {
	private selected: ModelRef = undefined;
	private physical: RoutedPhysicalModel | undefined;

	startSession(selected: ModelRef, branch: readonly SessionEntry[]): void {
		this.selected = selected;
		this.physical = latestRoutedPhysicalModel(branch);
	}

	selectModel(selected: ModelRef): void {
		this.selected = selected;
	}

	changeBranch(selected: ModelRef, branch: readonly SessionEntry[]): void {
		this.startSession(selected, branch);
	}

	messageEnded(message: unknown): boolean {
		const physical = routedPhysicalModelFromMessage(message);
		if (!physical) return false;
		this.physical = physical;
		return true;
	}

	get currentModel(): ModelRef | RoutedPhysicalModel {
		return this.selected?.api === "pi-virtual" ? (this.physical ?? this.selected) : this.selected;
	}
}

export default function (pi: ExtensionAPI): void {
	let last: UsageSnapshotEvent | undefined;
	let inFlight = false;
	let timer: ReturnType<typeof setInterval> | undefined;
	let stopWatch: (() => void) | undefined;
	let watchedProvider: UsageProvider | undefined;
	const modelTracker = new UsageModelTracker();

	function provider(): UsageProvider | undefined {
		return usageProviderForModel(modelTracker.currentModel);
	}

	function publish(snapshot: UsageSnapshot, fetchedAt = Date.now()): void {
		last = { fetchedAt, snapshot };
		pi.events.emit(USAGE_SNAPSHOT_EVENT, last);
	}

	function syncWatch(): void {
		const next = provider();
		if (next === watchedProvider) return;
		stopWatch?.();
		stopWatch = undefined;
		watchedProvider = next;
		if (next) stopWatch = watchCache(next, (entry) => publish(entry.snapshot, entry.fetchedAt));
	}

	function clearStaleSnapshot(source: UsageProvider | undefined): void {
		if (last?.snapshot.provider === source) return;
		const hadSnapshot = last !== undefined;
		last = undefined;
		if (hadSnapshot) pi.events.emit(USAGE_SNAPSHOT_EVENT, { fetchedAt: Date.now(), snapshot: UNAVAILABLE });
		if (!source) return;
		const entry = readCache(source);
		if (entry?.snapshot && !entry.snapshot.error) publish(entry.snapshot, entry.fetchedAt);
	}

	async function refresh(): Promise<void> {
		const source = provider();
		syncWatch();
		clearStaleSnapshot(source);
		if (inFlight) return;
		if (!source) {
			return;
		}
		const token = source === "anthropic" ? loadClaudeToken() : loadOpenAIToken();
		if (!token || (source === "anthropic" && !isOAuthToken(token))) {
			return;
		}

		inFlight = true;
		try {
			const snapshot = await fetchWithCache(source, token);
			if (snapshot && source === provider()) publish(snapshot);
		} finally {
			inFlight = false;
			if (source !== provider()) void refresh();
		}
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
		modelTracker.startSession(ctx.model, ctx.sessionManager.getBranch());
		syncWatch();
		clearStaleSnapshot(provider());
		if (last) pi.events.emit(USAGE_SNAPSHOT_EVENT, last);
		start();
		await refresh();
	});

	pi.on("model_select", async (event, ctx) => {
		modelTracker.selectModel(event.model ?? ctx.model);
		await refresh();
	});

	pi.on("message_end", async (event) => {
		if (!modelTracker.messageEnded(event.message)) return;
		await refresh();
	});

	pi.on("session_tree", async (_event, ctx) => {
		modelTracker.changeBranch(ctx.model, ctx.sessionManager.getBranch());
		await refresh();
	});

	pi.registerCommand("usage", {
		description: "Show subscription usage (status)",
		getArgumentCompletions: (prefix) =>
			["status"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action && action !== "status") {
				ctx.ui.notify("usage: unknown action (use /usage status)", "warning");
				return;
			}
			const week = findWindow(last?.snapshot, WEEK_LABEL);
			const fiveHour = findWindow(last?.snapshot, FIVE_HOUR_LABEL);
			ctx.ui.notify(
				[
					`usage provider: ${last?.snapshot.provider ?? "unknown"}`,
					`Codex week: ${percent(week?.usedPercent)}${week?.resetsAt ? `, resets ${formatLocalDateTime(week.resetsAt)}` : ""}`,
					`Codex 5h: ${fiveHour ? percent(fiveHour.usedPercent) : "none"}`,
				].join("\n"),
				"info",
			);
		},
	});

	pi.on("session_shutdown", async () => stop());
}
