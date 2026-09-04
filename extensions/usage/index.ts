/**
 * Single owner of subscription-usage polls. Claude and Codex / ChatGPT OAuth
 * usage are cached per provider and republished on pi's event bus.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	USAGE_REQUEST_EVENT,
	USAGE_SNAPSHOT_EVENT,
	type UsageProvider,
	type UsageSnapshot,
	type UsageSnapshotEvent,
	usageProviderForModel,
} from "./protocol.ts";
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

export default function (pi: ExtensionAPI): void {
	let last: UsageSnapshotEvent | undefined;
	let inFlight = false;
	let timer: ReturnType<typeof setInterval> | undefined;
	let stopWatch: (() => void) | undefined;
	let watchedProvider: UsageProvider | undefined;
	let model: { provider?: string; id?: string } | undefined;

	function provider(): UsageProvider | undefined {
		return usageProviderForModel(model);
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

	pi.on("session_shutdown", async () => stop());
}
