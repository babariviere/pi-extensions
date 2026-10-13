/** Subagent model authorization. Host defaults and caller-selected spawn models pass the same guards. */
import type { Model } from "@earendil-works/pi-ai";
import { subagentModelPriceError } from "./model-policy.ts";
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
	const enabled = readEnabledModels(cwd, projectTrusted);
	if (
		enabled.length &&
		!enabled.some((id) => qualifyModel(stripThinkingSuffix(id), choice.parentProvider) === stripThinkingSuffix(model))
	)
		throw new Error(`Subagent model '${model}' is not in enabledModels.`);
	const error = choice.models ? subagentModelPriceError(model, choice.models, choice.parentProvider) : undefined;
	if (error) throw new Error(error);
	return { ...choice, model };
}
