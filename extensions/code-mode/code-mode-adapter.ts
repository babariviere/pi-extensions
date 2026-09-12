import {
	createRegistry,
	type CodeModeTool,
	type Registry,
	type JsonSchema,
	type JsonValue,
} from "@babariviere/code-mode/packages/core/index.ts";
import type { ActionRegistry } from "./core/action-registry.ts";
import type { SpindleInvocationContext } from "./protocol.ts";
import type { SpindleSessionStore } from "./session-store.ts";

const schema = (value: Record<string, unknown>): JsonSchema => value as JsonSchema;
export interface InteractiveCodeModeRegistryOptions {
	readonly actionRegistry: ActionRegistry;
	readonly context: SpindleInvocationContext;
	readonly store: SpindleSessionStore;
	readonly invoke: (ref: string, input: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
	readonly providers: readonly string[];
	readonly noteState?: (note: { ref: string; key?: string; preview?: string; detail?: string }) => void;
}
/** Adapt only explicitly trusted providers. Captured sibling tools never become a guest namespace. */
export const createInteractiveCodeModeRegistry = async (
	options: InteractiveCodeModeRegistryOptions,
): Promise<Registry> => {
	const tools: CodeModeTool[] = [];
	for (const provider of options.providers) {
		const actions = await options.actionRegistry.list({ provider, limit: 1_000 }, options.context);
		for (const action of actions) {
			const id = `${provider}.${action.name}` as `${string}.${string}`;
			const readOnly = provider === "pi" && ["read", "grep", "find", "ls"].includes(action.name);
			tools.push({
				id,
				description: action.description,
				inputSchema: schema(action.inputSchema),
				...(action.outputSchema ? { outputSchema: schema(action.outputSchema) } : {}),
				effect: readOnly
					? "none"
					: provider === "pi"
						? "workspace-write"
						: provider === "web" || provider === "mcp"
							? "external"
							: "none",
				capabilities: [`${provider}.use`],
				execute: (input, context) => options.invoke(action.ref, input as Record<string, unknown>, context.signal),
			});
		}
	}
	const stateTools: CodeModeTool[] = [
		{
			id: "tau.get",
			description: "Read one value from the session-scoped τ scratchpad",
			inputSchema: {
				type: "object",
				properties: { key: { type: "string" } },
				required: ["key"],
				additionalProperties: false,
			},
			effect: "none",
			execute: (input) => {
				const key = (input as { key: string }).key;
				const result = options.store.get(key);
				options.noteState?.({
					ref: "spindle.state.get",
					key,
					...(result.found ? { preview: options.store.preview(key) } : { detail: "not held" }),
				});
				return result.value;
			},
		},
		{
			id: "tau.set",
			description: "Store a JSON value in the session-scoped τ scratchpad",
			inputSchema: {
				type: "object",
				properties: { key: { type: "string" }, value: {} },
				required: ["key", "value"],
				additionalProperties: false,
			},
			effect: "none",
			execute: (input) => {
				const value = input as { key: string; value: JsonValue };
				const result = options.store.set(value.key, value.value);
				options.noteState?.({
					ref: "spindle.state.set",
					key: value.key,
					preview: options.store.preview(value.key),
				});
				return result;
			},
		},
		{
			id: "tau.keys",
			description: "List values held in the session-scoped τ scratchpad",
			inputSchema: { type: "object", additionalProperties: false },
			effect: "none",
			execute: () => {
				const result = options.store.keys();
				options.noteState?.({ ref: "spindle.state.keys", detail: `${result.length} held` });
				return result;
			},
		},
		{
			id: "tau.delete",
			description: "Delete one value from the session-scoped τ scratchpad",
			inputSchema: {
				type: "object",
				properties: { key: { type: "string" } },
				required: ["key"],
				additionalProperties: false,
			},
			effect: "none",
			execute: (input) => {
				const key = (input as { key: string }).key;
				const result = options.store.delete(key);
				options.noteState?.({ ref: "spindle.state.delete", key, detail: result.deleted ? "deleted" : "not held" });
				return result;
			},
		},
		{
			id: "tau.clear",
			description: "Clear the session-scoped τ scratchpad",
			inputSchema: { type: "object", additionalProperties: false },
			effect: "none",
			execute: () => options.store.clear(),
		},
	];
	return createRegistry([...tools, ...stateTools]);
};
