/**
 * The host half of the guest/host call contract.
 *
 * Every `spindle.$*` ref the guest bridge can emit is answered by exactly one
 * entry in `HOST_CALLS`: the ref name and the handler that runs it. The
 * execution service dispatches through `hostCallTable` and nothing else. The
 * guest half (who emits each ref) is the `GUEST_SETUP` string literal in
 * `runtime/quickjs-runtime.ts`, and the declarations the guest type-checks
 * against live in `runtime/guest-types.ts`; the three stay in lockstep, and
 * `runtime/guest-host-refs.test.ts` guards the contract from the guest side.
 *
 * Handlers receive one `HostCallContext` per execution (registry, activity
 * store, guards, trace, workflow state) and the call's abort signal, so adding
 * a host call means adding one entry here: no switch case to find, no parallel
 * enumeration in the contract test to keep honest.
 */

import type {
	SpindleRunDisplay,
} from "./activity/types.ts";
import {
	executionOutcomeFromError,
	type SpindleExecutionFailureStageV1,
	type SpindleExecutionTraceOperationHandle,
} from "./audit/trace.ts";
import type { ActionRegistry } from "./core/action-registry.ts";
import type { SpindleInvocationContext } from "./protocol.ts";

/** The providers only reachable in full code mode. */
export const fullCodeProvider = (value: string): "pi" | "extensions" | undefined => {
	const separator = value.indexOf(".");
	const provider = separator > 0 ? value.slice(0, separator) : value;
	return provider === "pi" || provider === "extensions" ? provider : undefined;
};

/** Per-execution state and helpers a host-call handler runs against. */
export interface HostCallContext {
	registry: ActionRegistry;
	activity: import("./activity/store.ts").SpindleActivityStore | undefined;
	parentToolCallId: string;
	/** Effective full-code mode; gates pi/extensions visibility in discovery. */
	fullCodeMode: boolean;
	/** Ordered workflow phase names. No guest API appends to this today. */
	phases: string[];
	/** Live workflow span operations, keyed by the guest's span id. */
	workflowSpans: Map<string, { kind: "parallel" | "pipeline"; operation: SpindleExecutionTraceOperationHandle }>;
	/** The registry-shaped invocation context (base context plus the call's signal). */
	registryContext(signal: AbortSignal): SpindleInvocationContext & { signal: AbortSignal };
	/** Progress line update (`spindle.$progress`, phase announcements). */
	update(message: string): void;
	/** Refuse pi/extensions refs when full-code mode is off. */
	guardFullCodeRef(ref: string): void;
	/** Trace one host call through its stages. */
	traceAttempt<T>(
		traceRef: string,
		args: Record<string, unknown>,
		signal: AbortSignal,
		run: (setStage: (stage: SpindleExecutionFailureStageV1) => void) => T | Promise<T>,
	): Promise<T>;
	/** Trace operation for a workflow span start. */
	issueCall(ref: string, args: Record<string, unknown>): SpindleExecutionTraceOperationHandle;
	/** Provider dispatch with guard/trace/audit (the `spindle.$call` path). */
	invokeAction(ref: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}

/** One guest/host call: the bridge ref it answers, and how to run it. */
export interface HostCall {
	/** The guest bridge ref this entry answers, e.g. "spindle.$call". */
	ref: string;
	handle(args: Record<string, unknown>, ctx: HostCallContext, signal: AbortSignal): Promise<unknown> | unknown;
}

export const HOST_CALLS: readonly HostCall[] = [
	{
		ref: "spindle.$providers",
		handle: (args, ctx, signal) =>
			ctx.traceAttempt("spindle.discovery.providers", args, signal, () =>
				ctx.registry.providers().filter((provider) => ctx.fullCodeMode || !fullCodeProvider(provider.name)),
			),
	},
	{
		ref: "spindle.$catalog",
		handle: (args, ctx, signal) =>
			ctx.traceAttempt("spindle.discovery.catalog", args, signal, async (setStage) => {
				const provider = typeof args.provider === "string" ? args.provider : undefined;
				setStage("guard");
				if (provider) ctx.guardFullCodeRef(`${provider}.*`);
				setStage(provider && !ctx.registry.has(provider) ? "resolve" : "invoke");
				return ctx.registry.catalog(ctx.registryContext(signal), {
					...(provider ? { provider } : {}),
					...(typeof args.limit === "number" ? { limit: args.limit } : {}),
					includeProvider: (name) => ctx.fullCodeMode || !fullCodeProvider(name),
				});
			}),
	},
	{
		ref: "spindle.$list",
		handle: (args, ctx, signal) =>
			ctx.traceAttempt("spindle.discovery.list", args, signal, async (setStage) => {
				setStage("guard");
				if (typeof args.provider === "string") ctx.guardFullCodeRef(`${args.provider}.*`);
				setStage(typeof args.provider === "string" && !ctx.registry.has(args.provider) ? "resolve" : "invoke");
				const actions = await ctx.registry.list(
					{
						...(typeof args.provider === "string" ? { provider: args.provider } : {}),
						...(typeof args.namespace === "string" ? { namespace: args.namespace } : {}),
						...(typeof args.query === "string" ? { query: args.query } : {}),
						...(typeof args.limit === "number" ? { limit: args.limit } : {}),
					},
					ctx.registryContext(signal),
				);
				return actions.filter((action) => ctx.fullCodeMode || !fullCodeProvider(action.provider));
			}),
	},
	{
		ref: "spindle.$search",
		handle: (args, ctx, signal) =>
			ctx.traceAttempt("spindle.discovery.search", args, signal, async () => {
				const actions = await ctx.registry.search(
					String(args.query ?? ""),
					ctx.registryContext(signal),
					typeof args.limit === "number" ? args.limit : undefined,
				);
				return actions.filter((action) => ctx.fullCodeMode || !fullCodeProvider(action.provider));
			}),
	},
	{
		ref: "spindle.$describe",
		handle: (args, ctx, signal) =>
			ctx.traceAttempt("spindle.discovery.describe", args, signal, async (setStage) => {
				const targetRef = String(args.ref ?? "");
				setStage("guard");
				ctx.guardFullCodeRef(targetRef);
				setStage("resolve");
				return ctx.registry.describe(targetRef, ctx.registryContext(signal));
			}),
	},
	{
		ref: "spindle.$call",
		handle: (args, ctx, signal) => {
			const callArgs =
				typeof args.args === "object" && args.args !== null && !Array.isArray(args.args)
					? (args.args as Record<string, unknown>)
					: {};
			const targetRef = String(args.ref ?? "");
			return ctx.invokeAction(targetRef, callArgs, signal);
		},
	},
	{
		ref: "spindle.$progress",
		handle: (args, ctx, signal) =>
			ctx.traceAttempt("spindle.workflow.progress", args, signal, () =>
				ctx.update(String(args.message ?? "Working")),
			),
	},
	{
		ref: "spindle.$spanStart",
		handle: (args, ctx) => {
			const id = typeof args.id === "string" ? args.id : "";
			const kind = args.kind;
			if (!id || (kind !== "parallel" && kind !== "pipeline")) {
				throw new Error("Invalid internal workflow span start");
			}
			if (ctx.workflowSpans.has(id)) throw new Error("Duplicate internal workflow span");
			const operation = ctx.issueCall(`spindle.workflow.${kind}`, args);
			ctx.workflowSpans.set(id, { kind, operation });
			return undefined;
		},
	},
	{
		ref: "spindle.$spanEnd",
		handle: (args, ctx, signal) => {
			const id = typeof args.id === "string" ? args.id : "";
			const span = ctx.workflowSpans.get(id);
			if (!span) throw new Error("Unknown internal workflow span");
			ctx.workflowSpans.delete(id);
			if (args.outcome === "succeeded") span.operation.succeed(undefined);
			else {
				span.operation.fail(
					"invoke",
					undefined,
					executionOutcomeFromError(new Error("Workflow span failed"), signal),
				);
			}
			return undefined;
		},
	},
];

/** The dispatch table: ref -> entry. The execution service consults only this. */
export const hostCallTable: ReadonlyMap<string, HostCall> = new Map(HOST_CALLS.map((call) => [call.ref, call]));
