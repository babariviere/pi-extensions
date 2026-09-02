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

import type { SpindleActivityItemInput, SpindleRunDisplay } from "./activity/types.ts";
import {
	executionOutcomeFromError,
	type SpindleExecutionFailureStageV1,
	type SpindleExecutionTraceOperationHandle,
} from "./audit/trace.ts";
import type { ActionRegistry } from "./core/action-registry.ts";
import type { SpindleInvocationContext } from "./protocol.ts";
import type { SpindleSessionStore } from "./session-store.ts";

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
	/** Ordered phase names, appended when a top-level fan-out span opens. */
	phases: string[];
	/** Live workflow span operations, keyed by the guest's span id. */
	workflowSpans: Map<
		string,
		{
			kind: "parallel" | "pipeline";
			operation: SpindleExecutionTraceOperationHandle;
			phaseId?: string;
			/** Index into `phases`, so the chip can be rewritten with the outcome. */
			phaseIndex?: number;
			/** Latest status per item id, for the fan-out's ok/failed tally. */
			itemStatus?: Map<string, string>;
		}
	>;
	/** The registry-shaped invocation context (base context plus the call's signal). */
	registryContext(signal: AbortSignal): SpindleInvocationContext & { signal: AbortSignal };
	/** Progress line update (`spindle.$progress`, phase announcements). */
	update(message: string): void;
	/** Session-scoped scratchpad behind the guest's `τ` namespace. */
	store: SpindleSessionStore;
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
	/*
	 * The `τ` namespace: the session-scoped scratchpad (see session-store.ts).
	 *
	 * Five refs rather than a property-access proxy, because every one of these
	 * can fail (a bad key, a non-serializable value, a budget) and a failable
	 * operation must not read like an assignment. They are traced like any other
	 * host call, so a program that overruns a limit says so in the transcript.
	 */
	{
		ref: "spindle.$stateGet",
		handle: (args, ctx, signal) => ctx.traceAttempt("spindle.state.get", args, signal, () => ctx.store.get(args.key)),
	},
	{
		ref: "spindle.$stateSet",
		handle: (args, ctx, signal) =>
			ctx.traceAttempt("spindle.state.set", { key: args.key }, signal, () => ctx.store.set(args.key, args.value)),
	},
	{
		ref: "spindle.$stateKeys",
		handle: (args, ctx, signal) => ctx.traceAttempt("spindle.state.keys", args, signal, () => ctx.store.keys()),
	},
	{
		ref: "spindle.$stateDelete",
		handle: (args, ctx, signal) =>
			ctx.traceAttempt("spindle.state.delete", args, signal, () => ctx.store.delete(args.key)),
	},
	{
		ref: "spindle.$stateClear",
		handle: (args, ctx, signal) => ctx.traceAttempt("spindle.state.clear", args, signal, () => ctx.store.clear()),
	},
	{
		/**
		 * Batched per-item progress for a fan-out span. Never called by a
		 * model-facing API: the runtime derives these transitions inside
		 * mapLimit and the instrumented Promise.all, because it already knows
		 * the index, the total, and each element's outcome. The old
		 * `workflow.item` asked the model to describe items the host could see
		 * for itself, and was never called once in 11,054 recorded programs.
		 */
		ref: "spindle.$items",
		handle: (args, ctx, signal) =>
			ctx.traceAttempt("spindle.workflow.items", args, signal, () => {
				const batch = Array.isArray(args.items) ? args.items : [];
				const owner = [...ctx.workflowSpans.values()].find((span) => span.itemStatus !== undefined);
				let applied = 0;
				for (const entry of batch) {
					if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
					const input = entry as SpindleActivityItemInput;
					if (typeof input.id !== "string" || typeof input.label !== "string") continue;
					ctx.activity?.upsertItem(ctx.parentToolCallId, input);
					// Only the top-level span carries a status map, so a nested fan-out's
					// items are tallied against the fan-out the reader actually sees.
					owner?.itemStatus?.set(input.id, String(input.status ?? "running"));
					applied += 1;
				}
				return { applied };
			}),
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
			// A fan-out is the natural phase boundary, and opening a phase here is
			// what makes the inferred items visible: `activity/store.ts` stamps
			// every later item with `run.currentPhaseId`, and `ui/widget.ts`
			// renders phase progress only when that id is set. Without a producer
			// the whole existing render path stays dark.
			//
			// Only a top-level span opens one. A nested span (a wide Promise.all
			// inside a mapLimit mapper) would otherwise close its own parent's
			// phase, since store.phase() completes the previous one.
			let phaseId: string | undefined;
			let phaseIndex: number | undefined;
			if (ctx.workflowSpans.size === 0) {
				const itemCount = typeof args.itemCount === "number" ? args.itemCount : undefined;
				const name = itemCount !== undefined ? `fan-out \u00d7${itemCount}` : "fan-out";
				// An explicit id keeps consecutive fan-outs distinct: store.phase()
				// reuses a phase by name when no id is given.
				const phase = ctx.activity?.phase(ctx.parentToolCallId, {
					name,
					id,
					...(itemCount !== undefined ? { total: itemCount } : {}),
				});
				phaseId = phase?.id;
				phaseIndex = ctx.phases.length;
				ctx.phases.push(name);
				ctx.update(name);
			}
			ctx.workflowSpans.set(id, {
				kind,
				operation,
				...(phaseId ? { phaseId } : {}),
				...(phaseIndex !== undefined ? { phaseIndex, itemStatus: new Map<string, string>() } : {}),
			});
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
			// Close the fan-out's phase as soon as the fan-out is done, rather than
			// waiting for the next phase or the end of the run.
			if (span.phaseId) {
				ctx.activity?.completePhase(ctx.parentToolCallId, span.phaseId, args.outcome === "succeeded");
			}
			// Fold the tally into the phase chip the tool result already renders,
			// rather than adding a second surface for it.
			if (span.phaseIndex !== undefined && span.itemStatus) {
				let ok = 0;
				let failed = 0;
				for (const status of span.itemStatus.values()) {
					if (status === "completed") ok += 1;
					else if (status === "failed") failed += 1;
				}
				const base = ctx.phases[span.phaseIndex];
				if (base && ok + failed > 0) {
					ctx.phases[span.phaseIndex] = failed > 0 ? `${base} (${ok} ok, ${failed} failed)` : `${base} (${ok} ok)`;
				}
			}
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
