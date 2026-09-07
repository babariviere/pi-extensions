export interface SpindleModelIdentity {
	provider?: string;
	api?: string;
	id?: string;
}

export type SpindleEditProfile = "anthropic" | "openai" | "neutral";

/** Classifies only the stable provider/API/model identity used by edit guidance and metrics. */
export const resolveSpindleEditProfile = (model: SpindleModelIdentity | undefined): SpindleEditProfile => {
	const provider = model?.provider?.toLowerCase() ?? "";
	const api = model?.api?.toLowerCase() ?? "";
	const id = model?.id?.toLowerCase() ?? "";
	const identity = `${provider} ${api} ${id}`;

	if (/\b(?:anthropic|claude)\b/.test(identity)) return "anthropic";
	if (/\b(?:openai|gpt|codex)\b/.test(identity)) return "openai";
	return "neutral";
};
