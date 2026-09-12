export interface CodeModeModelIdentity {
	provider?: string;
	api?: string;
	id?: string;
}

export type CodeModeEditProfile = "anthropic" | "openai" | "neutral";

/** Classifies only the stable provider/API/model identity used by edit guidance and metrics. */
export const resolveCodeModeEditProfile = (model: CodeModeModelIdentity | undefined): CodeModeEditProfile => {
	const provider = model?.provider?.toLowerCase() ?? "";
	const api = model?.api?.toLowerCase() ?? "";
	const id = model?.id?.toLowerCase() ?? "";
	const identity = `${provider} ${api} ${id}`;

	if (/\b(?:anthropic|claude)\b/.test(identity)) return "anthropic";
	if (/\b(?:openai|gpt|codex)\b/.test(identity)) return "openai";
	return "neutral";
};
