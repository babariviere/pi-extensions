/**
 * Shared protocol for the `usage` extension.
 *
 * The `usage` extension owns the poll of the undocumented Claude OAuth usage
 * endpoint and republishes every refresh on pi's in-process event bus. Any
 * other extension (footer, night-mode, ...) consumes it from there instead of
 * fetching on its own.
 *
 * Channels:
 * - `usage:snapshot` (usage -> consumers): a `UsageSnapshotEvent` after each
 *   refresh, and in reply to a request.
 * - `usage:request` (consumers -> usage): ask for the current snapshot. The bus
 *   has no replay, so late subscribers use this to get an immediate value.
 *
 * This module is dependency free on purpose: importing it must never pull in
 * node builtins or start a poller.
 */

export const USAGE_SNAPSHOT_EVENT = "usage:snapshot";
export const USAGE_REQUEST_EVENT = "usage:request";

export const FIVE_HOUR_LABEL = "5h";
export const WEEK_LABEL = "Week";

export interface RateWindow {
	label: string;
	usedPercent: number;
	/** ISO timestamp at which the window resets (5h window only). */
	resetsAt?: string;
}

export interface UsageSnapshot {
	windows: RateWindow[];
	error?: string;
}

export interface UsageSnapshotEvent {
	/** Epoch ms at which this snapshot was fetched. */
	fetchedAt: number;
	snapshot: UsageSnapshot;
}

/** Narrow an untyped bus payload to a usage snapshot event. */
export function isUsageSnapshotEvent(data: unknown): data is UsageSnapshotEvent {
	if (!data || typeof data !== "object") return false;
	const candidate = data as Partial<UsageSnapshotEvent>;
	if (typeof candidate.fetchedAt !== "number") return false;
	const snapshot = candidate.snapshot;
	if (!snapshot || typeof snapshot !== "object") return false;
	return Array.isArray((snapshot as UsageSnapshot).windows);
}

/** Find a rate window by label, e.g. `findWindow(snapshot, FIVE_HOUR_LABEL)`. */
export function findWindow(snapshot: UsageSnapshot | undefined, label: string): RateWindow | undefined {
	if (!snapshot) return undefined;
	return snapshot.windows.find((w) => w.label === label);
}

/** True when the active model is served by the Anthropic subscription. */
export function isAnthropicModel(model: { provider?: string; id?: string } | undefined): boolean {
	const provider = model?.provider?.toLowerCase() ?? "";
	const id = model?.id?.toLowerCase() ?? "";
	if (provider) return provider.includes("anthropic");
	return id.includes("claude");
}
