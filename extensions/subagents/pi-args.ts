/** Model-name compatibility helpers. */

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

/** Strip a trailing `:thinking` suffix from a model id, if one is present. */
export function stripThinkingSuffix(model: string): string {
	const colonIdx = model.lastIndexOf(":");
	if (colonIdx !== -1 && THINKING_LEVELS.includes(model.substring(colonIdx + 1))) {
		return model.substring(0, colonIdx);
	}
	return model;
}

/** Extract a trailing `:thinking` suffix from a model id, if one is present. */
export function extractThinkingSuffix(model: string): string | undefined {
	const colonIdx = model.lastIndexOf(":");
	if (colonIdx !== -1 && THINKING_LEVELS.includes(model.substring(colonIdx + 1))) {
		return model.substring(colonIdx + 1);
	}
	return undefined;
}

/**
 * Qualify a bare model name with the default provider so pi routes it to the
 * intended provider. Already-qualified (`provider/model`), empty, or
 * provider-less-config models are returned unchanged.
 */
export function qualifyModel(model: string | undefined, defaultProvider: string | undefined): string | undefined {
	if (!model) return model;
	if (model.includes("/")) return model;
	if (!defaultProvider) return model;
	return `${defaultProvider}/${model}`;
}
