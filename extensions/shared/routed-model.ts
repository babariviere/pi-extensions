import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** A physical model and effort level recorded for one successful response. */
export interface RoutedPhysicalModel {
	provider: string;
	id: string;
	thinkingLevel?: string;
}

/** Extract the model that actually answered, ignoring incomplete and failed assistant messages. */
export function routedPhysicalModelFromMessage(message: unknown): RoutedPhysicalModel | undefined {
	if (!message || typeof message !== "object") return undefined;
	const candidate = message as {
		role?: unknown;
		api?: unknown;
		provider?: unknown;
		model?: unknown;
		responseModel?: unknown;
		stopReason?: unknown;
		thinkingLevel?: unknown;
		providerThinkingLevel?: unknown;
	};
	if (
		candidate.role !== "assistant" ||
		candidate.api === "pi-virtual" ||
		candidate.stopReason === undefined ||
		candidate.stopReason === "pending" ||
		candidate.stopReason === "deferred" ||
		candidate.stopReason === "aborted" ||
		candidate.stopReason === "error"
	) {
		return undefined;
	}
	const id =
		typeof candidate.responseModel === "string" && candidate.responseModel
			? candidate.responseModel
			: candidate.model;
	if (typeof candidate.provider !== "string" || typeof id !== "string" || !candidate.provider || !id) return undefined;
	const thinkingLevel =
		typeof candidate.thinkingLevel === "string"
			? candidate.thinkingLevel
			: typeof candidate.providerThinkingLevel === "string"
				? candidate.providerThinkingLevel
				: undefined;
	return { provider: candidate.provider, id, ...(thinkingLevel === undefined ? {} : { thinkingLevel }) };
}

/** Find the newest successful physical assistant response on the supplied active branch. */
export function latestRoutedPhysicalModel(branch: readonly SessionEntry[]): RoutedPhysicalModel | undefined {
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry?.type !== "message" || entry.message.role !== "assistant") continue;
		const model = routedPhysicalModelFromMessage(entry.message);
		if (model) return model;
	}
	return undefined;
}

/** Compare model identities without considering their selected thinking levels. */
export function sameRoutedModel(
	left: { provider?: string; id?: string } | undefined,
	right: { provider?: string; id?: string } | undefined,
): boolean {
	return (
		!!left?.provider &&
		!!left.id &&
		!!right?.provider &&
		!!right.id &&
		left.provider === right.provider &&
		left.id === right.id
	);
}
