import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { sandboxGuardWrite } from "../sandbox/service.ts";
import { latestRoutedPhysicalModel, routedPhysicalModelFromMessage } from "../shared/routed-model.ts";
import { createApplyPatchToolDefinition } from "./apply-patch.ts";

export function isOpenAIModel(model: { provider?: string; id?: string } | undefined): boolean {
	return /openai/i.test(model?.provider ?? "") || /^(?:openai\/)?gpt-/i.test(model?.id ?? "");
}

/** Keep model-specific tool selection out of the native execution runtime. */
export class OpenAIEditToolPolicy {
	readonly #removed = new Set<string>();
	openai = false;
	constructor(readonly pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">) {}
	apply(model: { provider?: string; id?: string } | undefined): void {
		this.openai = isOpenAIModel(model);
		const active = this.pi.getActiveTools();
		if (this.openai) {
			for (const name of ["edit", "write"]) if (active.includes(name)) this.#removed.add(name);
			const next = active.filter((name) => name !== "edit" && name !== "write");
			if (next.length !== active.length) this.pi.setActiveTools(next);
		} else if (this.#removed.size) {
			const next = [...active];
			for (const name of this.#removed) if (!next.includes(name)) next.push(name);
			this.#removed.clear();
			this.pi.setActiveTools(next);
		}
	}
}

/** An ordinary V4A function tool, not the provider-specific OpenAI apply_patch protocol. */
export function createApplyPatchTool(cwd: string, guard?: (path: string) => void): ToolDefinition<any, any> {
	const tool = createApplyPatchToolDefinition(cwd, guard);
	return {
		...tool,
		exposure: "direct",
		namespace: { name: "files", description: "Coordinated V4A file changes" },
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		executionMode: "sequential",
		outputSchema: Type.Object({
			changes: Type.Array(
				Type.Object({ kind: Type.String(), path: Type.String(), moveTo: Type.Optional(Type.String()) }),
			),
		}),
		async execute(id, args, signal, update, ctx) {
			if (signal?.aborted) throw signal.reason ?? new Error("Patch aborted");
			const result = await tool.execute(id, args, signal, update, ctx);
			return { ...result, structuredContent: result.details };
		},
	};
}

export default function applyPatch(pi: ExtensionAPI): void {
	const edits = new OpenAIEditToolPolicy(pi);
	const policyModel = (ctx: ExtensionContext, selected = ctx.model) =>
		selected?.api === "pi-virtual" ? latestRoutedPhysicalModel(ctx.sessionManager.getBranch()) : selected;
	// Resolve cwd per execution, including after /new, /resume and workspace changes.
	pi.registerTool({
		...createApplyPatchTool(process.cwd()),
		async execute(id, args, signal, update, ctx) {
			return createApplyPatchTool(ctx.cwd, (path) => sandboxGuardWrite(pi, path)).execute(
				id,
				args,
				signal,
				update,
				ctx,
			);
		},
	});
	pi.on("session_start", (_event, ctx) => edits.apply(policyModel(ctx)));
	pi.on("model_select", (event, ctx) => edits.apply(policyModel(ctx, event.model)));
	pi.on("before_agent_start", (_event, ctx) => edits.apply(policyModel(ctx)));
	pi.on("session_tree", (_event, ctx) => edits.apply(policyModel(ctx)));
	pi.on("message_end", (event, ctx) => {
		if (ctx.model?.api !== "pi-virtual") return;
		const physical = routedPhysicalModelFromMessage(event.message);
		if (physical) edits.apply(physical);
	});
	pi.on("tool_call", (event, ctx) => {
		if (
			(event.toolName === "edit" || event.toolName === "write") &&
			(edits.openai || isOpenAIModel(policyModel(ctx)))
		)
			return { block: true, reason: "OpenAI sessions use applyPatch for file changes; edit and write are disabled" };
	});
}
