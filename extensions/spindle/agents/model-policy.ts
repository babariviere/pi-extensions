import type { Model } from "@earendil-works/pi-ai";

import { qualifyModel, stripThinkingSuffix } from "./pi-args.ts";

const PRICE_CEILING_MODELS = ["claude-opus-5", "gpt-5.6-sol"];

/** A model price is comparable only when both primary billable rates are known. */
function rate(model: Model<any>): number | undefined {
	const input = model.cost?.input;
	const output = model.cost?.output;
	if (typeof input !== "number" || typeof output !== "number" || input < 0 || output < 0) return undefined;
	return input + output;
}

function matches(model: Model<any>, name: string): boolean {
	const candidate = name.toLowerCase();
	return model.id.toLowerCase() === candidate || `${model.provider}/${model.id}`.toLowerCase() === candidate;
}

/**
 * Reject a subagent model whose input-plus-output price exceeds the more
 * expensive approved reference model. Unknown models and missing pricing are
 * rejected, so a custom catalog entry cannot bypass the ceiling.
 */
export function subagentModelPriceError(
	modelName: string | undefined,
	models: readonly Model<any>[],
	defaultProvider: string | undefined,
): string | undefined {
	if (!modelName) return "No subagent model was resolved, so the price ceiling cannot be enforced.";
	const referenceRates = PRICE_CEILING_MODELS.map((id) => models.find((model) => matches(model, id))).map((model) =>
		model ? rate(model) : undefined,
	);
	if (referenceRates.some((value) => value === undefined)) {
		return `Cannot enforce the subagent price ceiling: ${PRICE_CEILING_MODELS.join(" or ")} is unavailable or unpriced.`;
	}
	const ceiling = Math.max(...(referenceRates as number[]));
	const bare = stripThinkingSuffix(modelName);
	const qualified = qualifyModel(bare, defaultProvider);
	const candidate = models.find(
		(model) => matches(model, bare) || (qualified !== undefined && matches(model, qualified)),
	);
	const candidateRate = candidate ? rate(candidate) : undefined;
	if (candidateRate === undefined)
		return `Model '${modelName}' is unavailable or has no pricing, so it cannot run as a subagent.`;
	if (candidateRate > ceiling) return `Model '${modelName}' exceeds the subagent price ceiling.`;
	return undefined;
}
