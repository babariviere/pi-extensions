/**
 * Ask Extension
 *
 * `pi --ask` runs the session on the cheapest model in the session's scoped set
 * (`enabledModels` in settings, or `--models`) with thinking off. Intended for
 * one-shot questions: `pi -p --ask "why is it called fabric?"`.
 *
 * The scoped set is the allowlist: a model that is not in `enabledModels` can
 * never be picked, so this stays in sync with settings instead of hardcoding a
 * model id in a shell alias.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";

/**
 * Rank by the per-million input + output rate. Models with an all-zero cost are
 * skipped: custom `models.json` entries default to zeros and would otherwise
 * always win the ranking without being cheap.
 */
function rate(model: Model<any>): number {
	const cost = model.cost;
	if (!cost) return 0;
	return (cost.input ?? 0) + (cost.output ?? 0);
}

/** The cheapest priced model of a candidate list, or undefined if none is priced. */
export function pickCheapestModel(candidates: readonly Model<any>[]): Model<any> | undefined {
	const priced = candidates.filter((model) => rate(model) > 0);
	if (priced.length === 0) return undefined;
	return priced.reduce((cheapest, model) => (rate(model) < rate(cheapest) ? model : cheapest));
}

/**
 * Candidates for the cheap model. The scoped set is authoritative when it is
 * configured; it is empty only when no scoping is set at all, in which case
 * every authenticated model is fair game.
 */
async function candidateModels(ctx: ExtensionContext): Promise<readonly Model<any>[]> {
	const scoped = ctx.scopedModels.map((entry) => entry.model);
	if (scoped.length > 0) return scoped;
	return await ctx.modelRegistry.getAvailable();
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("ask", {
		description: "Answer on the cheapest scoped model with thinking off",
		type: "boolean",
		default: false,
	});

	// Applied once per process. After that the user (or another extension) owns
	// the model, so a later `/model` switch is not silently reverted.
	let applied = false;

	pi.on("session_start", async (_event, ctx) => {
		if (applied || !pi.getFlag("ask")) return;
		applied = true;

		const cheapest = pickCheapestModel(await candidateModels(ctx));
		if (!cheapest) {
			if (ctx.hasUI) {
				ctx.ui.notify("--ask: no priced model in scope, keeping the current model", "warning");
			}
			return;
		}

		if (cheapest.id === ctx.model?.id && cheapest.provider === ctx.model?.provider) {
			pi.setThinkingLevel("off");
			return;
		}

		const ok = await pi.setModel(cheapest);
		if (!ok) {
			if (ctx.hasUI) {
				ctx.ui.notify(`--ask: no API key for ${cheapest.provider}/${cheapest.id}`, "error");
			}
			return;
		}
		pi.setThinkingLevel("off");
		if (ctx.hasUI) {
			ctx.ui.setStatus("ask", `ask: ${cheapest.provider}/${cheapest.id}`);
		}
	});
}
