/** Small tool-definition helpers shared by integrations. Pi owns dispatch and execution. */
import type { ExtensionContext, ToolAnnotations, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

export interface ActionDescriptor {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	outputSchema?: Record<string, unknown>;
	annotations?: ToolAnnotations;
}
export interface ActionContext {
	cwd: string;
	signal: AbortSignal | undefined;
	parentToolCallId: string;
	nestedToolCallId: string;
	extensionContext: ExtensionContext;
	update(message: string): void;
	activity?(
		update:
			| { type: "progress"; message: string }
			| { type: "entity"; id: string; kind: string; name?: string }
			| { type: "metrics"; tokens?: number; toolCalls?: number; cost?: number },
	): void;
}
export interface ActionListRequest {
	namespace?: string;
	query?: string;
	limit?: number;
}
/** Internal action grouping only, not a registration/discovery protocol. */
export interface ActionProvider {
	name: string;
	description: string;
	list(request: ActionListRequest, context: ActionContext): Promise<ActionDescriptor[]>;
	describe(action: string, context: ActionContext): Promise<ActionDescriptor | undefined>;
	prepareArguments?(
		action: string,
		args: Record<string, unknown>,
		context: ActionContext,
	): Record<string, unknown> | Promise<Record<string, unknown>>;
	invoke(action: string, args: Record<string, unknown>, context: ActionContext): Promise<unknown>;
	close?(): Promise<void>;
}

export function actionContext(
	ctx: ExtensionContext,
	id: string,
	signal?: AbortSignal,
	update: (message: string) => void = () => {},
): ActionContext {
	return { cwd: ctx.cwd, signal, parentToolCallId: id, nestedToolCallId: id, extensionContext: ctx, update };
}

export function createActionTool(provider: ActionProvider, descriptor: ActionDescriptor): ToolDefinition<any, any> {
	return {
		name: `${provider.name}_${descriptor.name}`,
		label: `${provider.name}.${descriptor.name}`,
		description: descriptor.description,
		parameters: Type.Unsafe(descriptor.inputSchema),
		outputSchema: descriptor.outputSchema ? Type.Unsafe(descriptor.outputSchema) : Type.Unknown(),
		exposure: "codemode",
		namespace: { name: provider.name, description: provider.description },
		annotations: descriptor.annotations,
		async execute(id, params, signal, update, ctx) {
			if (!params || typeof params !== "object" || Array.isArray(params))
				throw new Error("Tool arguments must be an object");
			const context = actionContext(ctx, id, signal, (message) =>
				update?.({ content: [{ type: "text", text: message }], details: undefined }),
			);
			const args = provider.prepareArguments
				? await provider.prepareArguments(descriptor.name, params as Record<string, unknown>, context)
				: params;
			if (!Value.Check(descriptor.inputSchema, args))
				throw new Error(`Invalid arguments for ${provider.name}.${descriptor.name}`);
			if (signal?.aborted) throw signal.reason ?? new Error("Tool call aborted");
			const value = await provider.invoke(descriptor.name, args as Record<string, unknown>, context);
			const body = JSON.stringify(value ?? null);
			if (body === undefined) throw new Error("Tool returned a non-JSON value");
			const preview = truncateHead(body);
			return {
				content: [
					{
						type: "text",
						text:
							preview.content +
							(preview.truncated ? "\n[Preview truncated. Use codemode to filter the structured result.]" : ""),
					},
				],
				structuredContent: JSON.parse(body),
				details: undefined,
			};
		},
	};
}
