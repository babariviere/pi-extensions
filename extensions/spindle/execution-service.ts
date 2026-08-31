import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	SpindleExecutionTraceRecorder,
	executionOutcomeFromError,
	type SpindleExecutionFailureStageV1,
	type SpindleExecutionTraceOperationHandle,
	type SpindleExecutionTraceV1,
} from "./audit/trace.ts";
import { SpindleActivityStore } from "./activity/store.ts";
import type { SpindleRunDisplay } from "./activity/types.ts";
import { MAX_AGENT_TIMEOUT_MS, MIN_AGENT_TIMEOUT_MS, type SpindleConfig } from "./config.ts";
import { fullCodeProvider, hostCallTable, type HostCallContext } from "./host-calls.ts";
import { ActionRegistry, type SpindleCallAudit, type SpindleRegistryActivityEvent } from "./core/action-registry.ts";
import type { SpindleToolGate } from "./core/tool-allowlist.ts";
import { redactRecordedArgs } from "./core/arg-redaction.ts";
import { spindleProcessSnapshot } from "./env-snapshot.ts";
import {
	codeUsesOrchestration,
	isAgentBudgetRef,
	isBlockingHostTimeoutRef,
	isBlockingOrchestrationRef,
	requestedBlockingTimeoutMs,
} from "./runtime/orchestration.ts";
import type {
	QuickJsRuntime,
	SpindleSandboxResult,
	SpindleSandboxTerminationReason,
} from "./runtime/quickjs-runtime.ts";
import type { SpindleTypeError } from "./runtime/type-checker.ts";

let runtimeDependencies:
	| Promise<{
			QuickJsRuntime: typeof import("./runtime/quickjs-runtime.ts").QuickJsRuntime;
			typeCheckSpindleCode: typeof import("./runtime/type-checker.ts").typeCheckSpindleCode;
			guestTypeDeclarations: typeof import("./runtime/guest-types.ts").guestTypeDeclarations;
	  }>
	| undefined;

const loadRuntimeDependencies = () =>
	(runtimeDependencies ??= Promise.all([
		import("./runtime/quickjs-runtime.ts"),
		import("./runtime/type-checker.ts"),
		import("./runtime/guest-types.ts"),
	]).then(([quickjs, checker, guest]) => ({
		QuickJsRuntime: quickjs.QuickJsRuntime,
		typeCheckSpindleCode: checker.typeCheckSpindleCode,
		guestTypeDeclarations: guest.guestTypeDeclarations,
	})));

// Slack added on top of a blocking host call's own timeout so the call fails
// with its own error before the sandbox deadline expires.
const BLOCKING_HOST_CALL_SLACK_MS = 5_000;

const executionOutcomeFromTermination = (
	reason: SpindleSandboxTerminationReason,
): "succeeded" | "failed" | "aborted" | "timed_out" => {
	switch (reason) {
		case "completed":
			return "succeeded";
		case "aborted":
			return "aborted";
		case "timed_out":
			return "timed_out";
		case "runtime_error":
			return "failed";
	}
};

export interface SpindleExecutionResult {
	success: boolean;
	value: unknown;
	logs: string[];
	audits: SpindleCallAudit[];
	phases: string[];
	trace: SpindleExecutionTraceV1;
	elapsedMs: number;
	typeErrors?: SpindleTypeError[];
	error?: string;
	usage?: Usage;
}

interface SpindleExecutionPartial {
	audits: SpindleCallAudit[];
	phases: string[];
	progress?: string | undefined;
}

export interface SpindleExecutionOptions {
	code: string;
	strings?: Record<string, string>;
	signal: AbortSignal | undefined;
	parentToolCallId: string;
	context: ExtensionContext;
	maxAgentCalls?: number;
	display?: SpindleRunDisplay;
	onPartial(snapshot: SpindleExecutionPartial): void;
}

export class SpindleExecutionService {
	#runtime: QuickJsRuntime | undefined;

	constructor(
		readonly registry: ActionRegistry,
		readonly config: SpindleConfig,
		readonly activity?: SpindleActivityStore,
		/** Subagent `tools:` gate; an unrestricted gate for a normal session. */
		readonly toolGate?: SpindleToolGate,
	) {}

	async execute(options: SpindleExecutionOptions): Promise<SpindleExecutionResult> {
		const startedAt = performance.now();
		const traceRecorder = new SpindleExecutionTraceRecorder();
		this.activity?.start(options.parentToolCallId, options.display);
		const dependencies = await loadRuntimeDependencies();
		const effectiveFullCodeMode = this.config.fullCodeMode;
		const checked = dependencies.typeCheckSpindleCode(
			options.code,
			dependencies.guestTypeDeclarations(effectiveFullCodeMode, this.toolGate),
		);
		if (checked.errors.length > 0) {
			// The widget and trace must say *why* the program never ran, not just
			// that it failed: surface the first errors verbatim (bounded).
			const typeErrorSummary = checked.errors
				.slice(0, 3)
				.map((error) => (error.line > 0 ? `L${error.line}:${error.column} ${error.message}` : error.message))
				.join("; ")
				.slice(0, 400);
			const failureMessage = `Type checking failed: ${typeErrorSummary}`;
			this.activity?.finish(options.parentToolCallId, false, failureMessage);
			return {
				success: false,
				value: undefined,
				logs: [],
				audits: [],
				phases: [],
				trace: traceRecorder.seal("failed", [], failureMessage),
				elapsedMs: performance.now() - startedAt,
				typeErrors: checked.errors,
			};
		}

		const audits: SpindleCallAudit[] = [];
		const phases: string[] = [];
		const workflowSpans = new Map<
			string,
			{ kind: "parallel" | "pipeline"; operation: SpindleExecutionTraceOperationHandle }
		>();
		let agentCalls = 0;
		const maxAgentCalls = Math.max(
			1,
			Math.min(options.maxAgentCalls ?? this.config.agents.maxPerExecution, this.config.agents.maxPerExecution),
		);
		const guardAgentCall = (ref: string): void => {
			if (!isAgentBudgetRef(ref)) return;
			agentCalls++;
			if (agentCalls > maxAgentCalls) {
				throw new Error(`Spindle agent budget exhausted (${maxAgentCalls} per execution)`);
			}
		};
		const guardFullCodeRef = (ref: string): void => {
			if (effectiveFullCodeMode) return;
			const provider = fullCodeProvider(ref);
			if (!provider) return;
			throw new Error(
				`Spindle full code mode is disabled; call ${provider === "pi" ? "Pi core" : "registered extension"} tools directly outside spindle_exec`,
			);
		};
		let currentProgress: string | undefined;
		let emitPending = false;
		let emitTimer: NodeJS.Timeout | undefined;
		const emitNow = (): void => {
			emitPending = false;
			options.onPartial({
				audits: audits.slice(),
				phases: phases.slice(),
				progress: currentProgress,
			});
		};
		const flushEmit = (): void => {
			if (emitTimer) clearTimeout(emitTimer);
			emitTimer = undefined;
			if (emitPending) emitNow();
		};
		// One execution-wide timer coalesces updates from every parallel nested
		// call. Keeping this global to the Spindle program prevents each call from
		// independently churning rows while preserving a trailing final snapshot.
		const emit = (): void => {
			emitPending = true;
			const debounceMs = this.config.ui.nestedToolDebounceMs;
			if (debounceMs <= 0) {
				flushEmit();
				return;
			}
			// Throttle to one render per window without resetting the timer. A
			// trailing debounce starves continuously streaming tools because every
			// delta postpones the render until the tool finishes.
			if (emitTimer) return;
			emitTimer = setTimeout(() => {
				emitTimer = undefined;
				if (emitPending) emitNow();
			}, debounceMs);
			emitTimer.unref?.();
		};
		const update = (message: string): void => {
			currentProgress = message;
			emit();
		};
		const observeInvocation = (event: SpindleRegistryActivityEvent): void => {
			if (this.activity) {
				if (event.type === "call_start") {
					this.activity.beginCall(options.parentToolCallId, event);
				} else if (event.type === "call_update") {
					this.activity.updateCall(options.parentToolCallId, event.callId, event.update);
				} else if (event.type === "call_args") {
					this.activity.updateCallArgs(options.parentToolCallId, event.callId, event.args);
				} else {
					this.activity.finishCall(options.parentToolCallId, event.callId, event);
				}
			}
			if (event.type === "call_end") emit();
		};
		const baseContext = {
			cwd: options.context.cwd,
			signal: options.signal,
			parentToolCallId: options.parentToolCallId,
			nestedToolCallId: `${options.parentToolCallId}_metadata`,
			extensionContext: options.context,
			update,
		};
		// Start known orchestration programs with the longer deadline. Calls
		// reached through generic or computed refs are classified again at the
		// host bridge and can extend the active sandbox deadline before they run.
		// The sandbox deadline of an orchestration program sits one slack window past
		// every agent deadline it can wait on (the child cap and the wait window), so
		// the inner call always reports its own outcome before the executor kills the
		// program waiting for it.
		const orchestrationTimeoutMs =
			Math.max(this.config.executor.timeoutMs, this.config.agents.timeoutMs, this.config.agents.waitMs) +
			BLOCKING_HOST_CALL_SLACK_MS;
		const effectiveTimeoutMs = codeUsesOrchestration(options.code)
			? orchestrationTimeoutMs
			: this.config.executor.timeoutMs;
		const minimumTimeoutMsForHostCall = (ref: string, args: Record<string, unknown>): number | undefined => {
			const requested = requestedBlockingTimeoutMs(ref, args);
			if (isBlockingOrchestrationRef(ref)) {
				const requestedTimeoutMs =
					requested > 0
						? Math.max(MIN_AGENT_TIMEOUT_MS, Math.min(Math.floor(requested), MAX_AGENT_TIMEOUT_MS))
						: 0;
				return Math.max(orchestrationTimeoutMs, requestedTimeoutMs + BLOCKING_HOST_CALL_SLACK_MS);
			}
			// A blocking host call with an explicit timeout (pi.bash) owns its own
			// deadline: extend the sandbox past it, plus slack, so the call reports
			// its own timeout instead of the executor killing the whole program.
			if (isBlockingHostTimeoutRef(ref) && requested > 0) {
				const requestedTimeoutMs = Math.min(Math.floor(requested), MAX_AGENT_TIMEOUT_MS);
				return Math.max(this.config.executor.timeoutMs, requestedTimeoutMs + BLOCKING_HOST_CALL_SLACK_MS);
			}
			return undefined;
		};
		const traceAttempt = async <T>(
			ref: string,
			args: Record<string, unknown>,
			signal: AbortSignal,
			run: (setStage: (stage: SpindleExecutionFailureStageV1) => void) => T | Promise<T>,
		): Promise<T> => {
			const operation = traceRecorder.issueCall(ref, args);
			let stage: SpindleExecutionFailureStageV1 = "invoke";
			try {
				const value = await run((nextStage) => {
					stage = nextStage;
				});
				operation.succeed(undefined);
				return value;
			} catch (error) {
				operation.fail(stage, error, executionOutcomeFromError(error, signal));
				throw error;
			}
		};
		const invokeAction = async (
			ref: string,
			args: Record<string, unknown>,
			callContext: typeof baseContext & { signal: AbortSignal },
		): Promise<unknown> => {
			const traceOperation = traceRecorder.issueCall(ref, redactRecordedArgs(ref, args));
			try {
				guardFullCodeRef(ref);
				guardAgentCall(ref);
			} catch (error) {
				traceOperation.fail("guard", error, executionOutcomeFromError(error, callContext.signal));
				throw error;
			}
			return this.registry.invoke(ref, args, {
				...callContext,
				audits,
				maxResultChars: this.config.executor.maxNestedResultChars,
				traceOperation,
				observeInvocation,
			});
		};
		// The per-execution state every host-call handler runs against; dispatch
		// itself is a table lookup (see host-calls.ts).
		const hostContext: HostCallContext = {
			registry: this.registry,
			activity: this.activity,
			parentToolCallId: options.parentToolCallId,
			fullCodeMode: effectiveFullCodeMode,
			phases,
			workflowSpans,
			registryContext: (signal) => ({ ...baseContext, signal }),
			update,
			guardFullCodeRef,
			traceAttempt,
			issueCall: (ref, args) => traceRecorder.issueCall(ref, args),
			invokeAction: (ref, args, signal) => invokeAction(ref, args, { ...baseContext, signal }),
		};
		let sandboxResult: SpindleSandboxResult;
		try {
			this.#runtime ??= new dependencies.QuickJsRuntime();
			sandboxResult = await this.#runtime.execute(
				options.code,
				async (ref, args, runtimeSignal) => {
					const hostCall = hostCallTable.get(ref);
					if (hostCall) return hostCall.handle(args, hostContext, runtimeSignal);
					return invokeAction(ref, args, { ...baseContext, signal: runtimeSignal });
				},
				{
					timeoutMs: effectiveTimeoutMs,
					memoryLimitBytes: this.config.executor.memoryLimitBytes,
					maxLogChars: this.config.executor.maxOutputChars,
					minimumTimeoutMsForHostCall,
					...(checked.javascript ? { transpiledCode: checked.javascript } : {}),
					// The map for checked.javascript, so guest stack positions map back
					// to the program the model wrote (runtime/source-map.ts).
					...(checked.javascript && checked.sourceMap ? { sourceMap: checked.sourceMap } : {}),
					...(options.strings ? { strings: options.strings } : {}),
					// Allowlisted env snapshot injected as the guest's `process` global.
					process: spindleProcessSnapshot(options.context.cwd),
					...(options.signal ? { signal: options.signal } : {}),
				},
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.activity?.finish(options.parentToolCallId, false, message);
			throw error;
		} finally {
			await this.registry.endInvocation(options.parentToolCallId);
			flushEmit();
		}

		const runOutcome = executionOutcomeFromTermination(sandboxResult.terminationReason);
		const succeeded = runOutcome === "succeeded";
		this.activity?.finish(options.parentToolCallId, succeeded, sandboxResult.error);
		return {
			success: succeeded,
			value: sandboxResult.value,
			logs: sandboxResult.logs,
			audits,
			phases,
			trace: traceRecorder.seal(runOutcome, phases, sandboxResult.error),
			elapsedMs: performance.now() - startedAt,
			...(sandboxResult.error ? { error: sandboxResult.error } : {}),
		};
	}
}
