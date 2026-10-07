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
	/** Longer usage guidance exposed through codemode's describeNamespace(). */
	instructions?: string;
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

/** Expose a provider as one tool. Action-specific schemas remain the execution contract. */
export function createActionsTool(provider: ActionProvider, descriptors: ActionDescriptor[]): ToolDefinition<any, any> {
	if (!descriptors.length) throw new Error("An action tool needs at least one action");
	const actions = new Map(
		descriptors.map((descriptor) => [descriptor.name, createActionExecutor(provider, descriptor)]),
	);
	const properties: Record<string, unknown> = {};
	for (const descriptor of descriptors) Object.assign(properties, descriptor.inputSchema.properties);
	const outputSchemas = [
		...new Map(
			descriptors.map((descriptor) => [JSON.stringify(descriptor.outputSchema), descriptor.outputSchema]),
		).values(),
	];
	return {
		name: provider.name,
		label: provider.name,
		description: [
			provider.description,
			...descriptors.map((descriptor) => {
				const required = descriptor.inputSchema.required as string[] | undefined;
				return `${descriptor.name}: ${descriptor.description}${required?.length ? ` Required: ${required.join(", ")}.` : ""}`;
			}),
		].join("\n"),
		parameters: Type.Unsafe({
			type: "object",
			properties: {
				...properties,
				action: { type: "string", enum: descriptors.map((descriptor) => descriptor.name) },
			},
			required: ["action"],
			additionalProperties: false,
		}),
		outputSchema: descriptors.every((descriptor) => descriptor.outputSchema)
			? Type.Unsafe({ anyOf: outputSchemas })
			: Type.Unknown(),
		exposure: "codemode",
		namespace: {
			name: provider.name,
			description: provider.description,
			...(provider.instructions ? { instructions: provider.instructions } : {}),
		},
		// One tool cannot advertise per-action hints. Aggregate conservatively.
		annotations: {
			readOnlyHint: descriptors.every((descriptor) => descriptor.annotations?.readOnlyHint === true),
			destructiveHint: descriptors.some((descriptor) => descriptor.annotations?.destructiveHint !== false),
			idempotentHint: descriptors.every((descriptor) => descriptor.annotations?.idempotentHint === true),
			openWorldHint: descriptors.some((descriptor) => descriptor.annotations?.openWorldHint !== false),
		},
		async execute(id, params, signal, update, ctx) {
			if (!params || typeof params !== "object" || Array.isArray(params))
				throw new Error("Tool arguments must be an object");
			const { action, ...args } = params as Record<string, unknown>;
			const execute = typeof action === "string" ? actions.get(action) : undefined;
			if (!execute) throw new Error(`Unknown ${provider.name} action: ${String(action)}`);
			return execute(id, args, signal, update, ctx);
		},
	};
}

function createActionExecutor(
	provider: ActionProvider,
	descriptor: ActionDescriptor,
): ToolDefinition<any, any>["execute"] {
	return async (id, params, signal, update, ctx) => {
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
	};
}
