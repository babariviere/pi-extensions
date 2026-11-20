/** Subagent model authorization. Host defaults and caller-selected spawn models pass the same guards. */
import type { Model } from "@earendil-works/pi-ai";
import { qualifyModel, stripThinkingSuffix } from "./pi-args.ts";
import { readEnabledModels } from "./settings.ts";

export interface HostModel {
	model?: string;
	thinking?: string;
	parentProvider?: string;
	models?: readonly Model<any>[];
}

export function validateHostModel(choice: HostModel, cwd: string, projectTrusted = false): HostModel {
	const model = qualifyModel(choice.model, choice.parentProvider);
	if (!model) throw new Error("Subagents require a host defaultModel or a resolved parent model");
	const bare = stripThinkingSuffix(model);
	const enabled = readEnabledModels(cwd, projectTrusted);
	if (enabled.length && !enabled.some((id) => qualifyModel(stripThinkingSuffix(id), choice.parentProvider) === bare))
		throw new Error(`Subagent model '${model}' is not in enabledModels.`);
	const candidate = bare.toLowerCase();
	if (
		choice.models &&
		!choice.models.some(
			({ id, provider }) => id.toLowerCase() === candidate || `${provider}/${id}`.toLowerCase() === candidate,
		)
	)
		throw new Error(`Subagent model '${model}' is unavailable.`);
	return { ...choice, model };
}
