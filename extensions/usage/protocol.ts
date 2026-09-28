/** Shared protocol for subscription-usage snapshots. */

export const USAGE_SNAPSHOT_EVENT = "usage:snapshot";
export const USAGE_REQUEST_EVENT = "usage:request";

export const FIVE_HOUR_LABEL = "5h";
export const WEEK_LABEL = "Week";

export type UsageProvider = "anthropic" | "openai";

export interface RateWindow {
	label: string;
	usedPercent: number;
	/** ISO timestamp at which the window resets. */
	resetsAt?: string;
}

export interface UsageSnapshot {
	provider?: UsageProvider;
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

/** Find a rate window by label, e.g. findWindow(snapshot, FIVE_HOUR_LABEL). */
export function findWindow(snapshot: UsageSnapshot | undefined, label: string): RateWindow | undefined {
	return snapshot?.windows.find((window) => window.label === label);
}

/** True when the active model is served by the Anthropic subscription. */
export function isAnthropicModel(model: { provider?: string; id?: string } | undefined): boolean {
	const provider = model?.provider?.toLowerCase() ?? "";
	const id = model?.id?.toLowerCase() ?? "";
	return provider ? provider.includes("anthropic") : id.includes("claude");
}

/** True when the active model is served by the Codex / ChatGPT subscription. */
export function isOpenAIModel(model: { provider?: string; id?: string } | undefined): boolean {
	const provider = model?.provider?.toLowerCase() ?? "";
	const id = model?.id?.toLowerCase() ?? "";
	return provider.includes("codex") || (!provider && id.includes("codex"));
}

/** Return the subscription provider that can supply usage for a model. */
export function usageProviderForModel(
	model: { provider?: string; id?: string } | undefined,
): UsageProvider | undefined {
	if (isAnthropicModel(model)) return "anthropic";
	if (isOpenAIModel(model)) return "openai";
	return undefined;
}
