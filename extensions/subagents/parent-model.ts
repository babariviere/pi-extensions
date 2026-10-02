import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { routedPhysicalModelFromMessage } from "../shared/routed-model.ts";

/** Child CLIs inherit the dispatched catalog ID, never a parent's virtual selection. */
export function inheritedParentModel(
	ctx: Pick<ExtensionContext, "model" | "sessionManager">,
): { provider: string; id: string } | undefined {
	if (ctx.model?.api !== "pi-virtual") return ctx.model;
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		if (!routedPhysicalModelFromMessage(entry.message)) continue;
		// responseModel may be an upstream alias not recognized by the host catalog.
		return { provider: entry.message.provider, id: entry.message.model };
	}
	return undefined;
}
