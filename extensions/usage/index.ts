/**
 * Subscription-usage polls for Claude and Codex / ChatGPT OAuth accounts. One
 * process per provider holds the poll lease and fetches; every pi process
 * republishes the shared cache on its own event bus.
 */

import { type ExtensionAPI, getAgentDir, type ModelRegistry, type SessionEntry } from "@earendil-works/pi-coding-agent";
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
	acquireLease,
	fetchWithCache,
	loadToken,
	REFRESH_INTERVAL_MS,
	readCache,
	readLease,
	releaseLease,
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
	let leasedProvider: UsageProvider | undefined;
	let modelRegistry: ModelRegistry | undefined;
	const modelTracker = new UsageModelTracker();
	const agentDir = getAgentDir();

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
		if (next) stopWatch = watchCache(next, (entry) => publish(entry.snapshot, entry.fetchedAt), agentDir);
	}

	function clearStaleSnapshot(source: UsageProvider | undefined): void {
		if (last?.snapshot.provider === source) return;
		const hadSnapshot = last !== undefined;
		last = undefined;
		if (hadSnapshot) pi.events.emit(USAGE_SNAPSHOT_EVENT, { fetchedAt: Date.now(), snapshot: UNAVAILABLE });
		if (!source) return;
		const entry = readCache(source, agentDir);
		if (entry?.snapshot && !entry.snapshot.error) publish(entry.snapshot, entry.fetchedAt);
	}

	function releaseHeldLease(): void {
		if (leasedProvider) releaseLease(leasedProvider, agentDir);
		leasedProvider = undefined;
	}

	async function refresh(): Promise<void> {
		const source = provider();
		syncWatch();
		clearStaleSnapshot(source);
		if (leasedProvider !== source) releaseHeldLease();
		if (inFlight) return;
		if (!source) {
			return;
		}
		// Followers receive the poller's snapshots through the cache watch.
		if (!acquireLease(source, agentDir)) return;
		leasedProvider = source;

		inFlight = true;
		try {
			const token = await loadToken(source, { agentDir, modelRegistry });
			// Without credentials, leave polling to a process that has them.
			if (!token) {
				if (leasedProvider === source) releaseHeldLease();
				return;
			}
			const snapshot = await fetchWithCache(source, token, agentDir);
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
		releaseHeldLease();
	}

	pi.events.on(USAGE_REQUEST_EVENT, () => {
		if (last) pi.events.emit(USAGE_SNAPSHOT_EVENT, last);
		else void refresh();
	});

	pi.on("session_start", async (_event, ctx) => {
		modelRegistry = ctx.modelRegistry;
		modelTracker.startSession(ctx.model, ctx.sessionManager.getBranch());
		syncWatch();
		clearStaleSnapshot(provider());
		if (last) pi.events.emit(USAGE_SNAPSHOT_EVENT, last);
		start();
		await refresh();
	});

	pi.on("model_select", async (event, ctx) => {
		modelRegistry = ctx.modelRegistry;
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
			const source = provider();
			const lease = source ? readLease(source, agentDir) : undefined;
			const poller = !lease ? "none" : lease.pid === process.pid ? "this session" : `pid ${lease.pid}`;
			ctx.ui.notify(
				[
					`usage provider: ${last?.snapshot.provider ?? "unknown"}`,
					`usage poller: ${poller}`,
					`Codex week: ${percent(week?.usedPercent)}${week?.resetsAt ? `, resets ${formatLocalDateTime(week.resetsAt)}` : ""}`,
					`Codex 5h: ${fiveHour ? percent(fiveHour.usedPercent) : "none"}`,
				].join("\n"),
				"info",
			);
		},
	});

	pi.on("session_shutdown", async () => stop());
}
