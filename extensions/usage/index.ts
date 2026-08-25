/**
 * usage
 *
 * Single owner of the Claude subscription usage poll. Fetches the OAuth usage
 * endpoint once a minute (coordinated across pi instances through a file cache)
 * and republishes every refresh on pi's event bus so other extensions do not
 * each roll their own poller.
 *
 * Emits `usage:snapshot` with `{ fetchedAt, snapshot }`.
 * Replies to `usage:request` with the current snapshot (the bus has no replay).
 *
 * Consumers: `footer` (usage bars), `night-mode` (5h budget guard).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	USAGE_REQUEST_EVENT,
	USAGE_SNAPSHOT_EVENT,
	type UsageSnapshot,
	type UsageSnapshotEvent,
	isAnthropicModel,
} from "./protocol.ts";
import { REFRESH_INTERVAL_MS, fetchWithCache, isOAuthToken, loadClaudeToken, readCache, watchCache } from "./source.ts";

const UNAVAILABLE: UsageSnapshot = { windows: [] };

export default function (pi: ExtensionAPI): void {
	let last: UsageSnapshotEvent | undefined;
	let inFlight = false;
	let timer: ReturnType<typeof setInterval> | undefined;
	let stopWatch: (() => void) | undefined;
	let model: { provider?: string; id?: string } | undefined;

	function publish(snapshot: UsageSnapshot, fetchedAt = Date.now()): void {
		last = { fetchedAt, snapshot };
		pi.events.emit(USAGE_SNAPSHOT_EVENT, last);
	}

	async function refresh(): Promise<void> {
		if (inFlight) return;

		// Only meaningful for an OAuth Anthropic subscription session.
		if (!isAnthropicModel(model)) {
			if (last && last.snapshot.windows.length > 0) publish(UNAVAILABLE);
			return;
		}
		const token = loadClaudeToken();
		if (!token || !isOAuthToken(token)) {
			if (last && last.snapshot.windows.length > 0) publish(UNAVAILABLE);
			return;
		}

		inFlight = true;
		try {
			const snapshot = await fetchWithCache(token);
			// Undefined means we deferred to another instance / are backing off:
			// keep the last good state instead of publishing a hole.
			if (snapshot) publish(snapshot);
		} finally {
			inFlight = false;
		}
	}

	/** Publish whatever the shared cache holds, even if stale, for a fast first paint. */
	function seedFromCache(): void {
		if (last) return;
		const entry = readCache();
		if (entry?.snapshot && !entry.snapshot.error) publish(entry.snapshot, entry.fetchedAt);
	}

	function start(): void {
		if (!timer) {
			timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
			timer.unref?.();
		}
		stopWatch ??= watchCache((entry) => publish(entry.snapshot, entry.fetchedAt));
	}

	function stop(): void {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
		stopWatch?.();
		stopWatch = undefined;
	}

	// Late subscribers ask for the current value instead of waiting a full tick.
	pi.events.on(USAGE_REQUEST_EVENT, () => {
		if (last) pi.events.emit(USAGE_SNAPSHOT_EVENT, last);
		else void refresh();
	});

	pi.on("session_start", async (_event, ctx) => {
		model = ctx.model;
		seedFromCache();
		// Republish on every session start so consumers that (re)subscribed during
		// this load get a value without racing the request channel.
		if (last) pi.events.emit(USAGE_SNAPSHOT_EVENT, last);
		start();
		await refresh();
	});

	// Model switch can flip the provider on/off; refresh immediately.
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

	pi.on("session_shutdown", async () => {
		stop();
	});
}
