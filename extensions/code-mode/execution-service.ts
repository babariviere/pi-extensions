import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CodeModeActivityStore } from "./activity/store.ts";
import type { CodeModeRunDisplay } from "./activity/types.ts";
import {
	executionOutcomeFromError,
	type CodeModeExecutionFailureStageV1,
	CodeModeExecutionTraceRecorder,
	type CodeModeExecutionTraceV1,
} from "./audit/trace.ts";
import { MAX_AGENT_TIMEOUT_MS, MIN_AGENT_TIMEOUT_MS, type CodeModeConfig } from "./config.ts";
import type { ActionRegistry, CodeModeCallAudit, CodeModeRegistryActivityEvent } from "./core/action-registry.ts";
import { redactRecordedArgs } from "./core/arg-redaction.ts";
import { piBashExitMetadata } from "./core/pi-bash-error.ts";
import { codeModeProcessSnapshot } from "./env-snapshot.ts";
import { fullCodeProvider, type HostCallContext, hostCallTable, type CodeModeStateNote } from "./host-calls.ts";
import type { CodeModeGuestTypeSources } from "./protocol.ts";
import { buildDynamicGuestDeclarations } from "./runtime/dynamic-guest-types.ts";
import { guestTypeDeclarations } from "./runtime/guest-types.ts";
import {
	QuickJsRuntime,
	type CodeModeSandboxResult,
	type CodeModeSandboxTerminationReason,
} from "./runtime/quickjs-runtime.ts";
import { type CodeModeTypeError, typeCheckCodeModeCode } from "./runtime/type-checker.ts";
import {
	codeUsesOrchestration,
	isAgentBudgetRef,
	isBlockingHostTimeoutRef,
	isBlockingOrchestrationRef,
	requestedBlockingTimeoutMs,
} from "./runtime/orchestration.ts";
import { CodeModeSessionStore, type CodeModeSessionStoreKey } from "./session-store.ts";

// Slack added on top of a blocking host call's own timeout so the call fails
// with its own error before the sandbox deadline expires.
const BLOCKING_HOST_CALL_SLACK_MS = 5_000;

const executionOutcomeFromTermination = (
	reason: CodeModeSandboxTerminationReason,
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
		default:
			throw new Error(`Unknown sandbox termination reason: ${reason satisfies never}`);
	}
};

export interface CodeModeExecutionResult {
	success: boolean;
	value: unknown;
	logs: string[];
	audits: CodeModeCallAudit[];
	phases: string[];
	trace: CodeModeExecutionTraceV1;
	elapsedMs: number;
	typeErrors?: CodeModeTypeError[];
	error?: string;
	usage?: Usage;
	/**
	 * Keys the session scratchpad holds, reported only when this program actually
	 * touched τ. A program that never mentions the scratchpad should not be told
	 * about it; one that does needs to know what it left behind.
	 */
	stateKeys?: CodeModeSessionStoreKey[];
	/** Live-only τ operation notes for the TUI rows (never persisted). */
	stateNotes?: CodeModeStateNote[];
}

interface CodeModeExecutionPartial {
	audits: CodeModeCallAudit[];
	phases: string[];
	progress?: string | undefined;
	/** τ operations so far, in order, for the live rows. */
	stateNotes: CodeModeStateNote[];
}

export interface CodeModeExecutionOptions {
	code: string;
	payloads?: Record<string, string>;
	signal: AbortSignal | undefined;
	parentToolCallId: string;
	context: ExtensionContext;
	maxAgentCalls?: number;
	/**
	 * Whole-program deadline requested by this invocation. It raises (never
	 * lowers) `executor.timeoutMs` and is capped by `executor.maxTimeoutMs`.
	 */
	requestedTimeoutMs?: number;
	display?: CodeModeRunDisplay;
	onPartial(snapshot: CodeModeExecutionPartial): void;
}

export class CodeModeExecutionService {
	#runtime: QuickJsRuntime | undefined;

	constructor(
		readonly registry: ActionRegistry,
		readonly config: CodeModeConfig,
		readonly activity?: CodeModeActivityStore,
		/**
		 * The session-scoped scratchpad behind the guest's `τ` namespace. Owned by
		 * `CodeModeState` in a real session, so it outlives one program; a private
		 * one keeps a standalone service (tests) self-contained.
		 */
		readonly store: CodeModeSessionStore = new CodeModeSessionStore(),
	) {}

	async execute(options: CodeModeExecutionOptions): Promise<CodeModeExecutionResult> {
		/* istanbul ignore next: retained as the compatibility reference during migration. */
		const startedAt = performance.now();
		const traceRecorder = new CodeModeExecutionTraceRecorder();
		this.activity?.start(options.parentToolCallId, options.display);
		const effectiveFullCodeMode = this.config.fullCodeMode;
		// Schema-typed declarations for this execution. Best effort: a provider
		// that cannot list itself leaves its loose declaration in place.
		let guestTypeSources: CodeModeGuestTypeSources = {};
		try {
			guestTypeSources = await this.registry.guestTypeSources({
				cwd: options.context.cwd,
				signal: options.signal,
				parentToolCallId: options.parentToolCallId,
				nestedToolCallId: `${options.parentToolCallId}_types`,
				extensionContext: options.context,
				update: () => {},
			});
		} catch {
			guestTypeSources = {};
		}
		const checked = typeCheckCodeModeCode(
			options.code,
			guestTypeDeclarations(
				effectiveFullCodeMode,
				buildDynamicGuestDeclarations(guestTypeSources),
				this.registry
					.providers()
					.filter((provider) => effectiveFullCodeMode || !this.registry.isFullCodeProvider(provider.name))
					.map((provider) => provider.name),
			),
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

		const audits: CodeModeCallAudit[] = [];
		const phases: string[] = [];
		let agentCalls = 0;
		const maxAgentCalls = Math.max(
			1,
			Math.min(options.maxAgentCalls ?? this.config.agents.maxPerExecution, this.config.agents.maxPerExecution),
		);
		const guardAgentCall = (ref: string): void => {
			if (!isAgentBudgetRef(ref)) return;
			agentCalls++;
			if (agentCalls > maxAgentCalls) {
				throw new Error(`Code Mode agent budget exhausted (${maxAgentCalls} per execution)`);
			}
		};
		const guardFullCodeRef = (ref: string): void => {
			if (effectiveFullCodeMode) return;
			const provider = fullCodeProvider(ref, (name) => this.registry.isFullCodeProvider(name));
			if (!provider) return;
			throw new Error(
				`Code Mode full code mode is disabled; call ${provider === "pi" ? "Pi core" : "registered extension"} tools directly outside code_mode`,
			);
		};
		const stateNotes: CodeModeStateNote[] = [];
		let currentProgress: string | undefined;
		let emitPending = false;
		let emitTimer: NodeJS.Timeout | undefined;
		const emitNow = (): void => {
			emitPending = false;
			options.onPartial({
				audits: audits.slice(),
				phases: phases.slice(),
				progress: currentProgress,
				stateNotes: stateNotes.slice(),
			});
		};
		const flushEmit = (): void => {
			if (emitTimer) clearTimeout(emitTimer);
			emitTimer = undefined;
			if (emitPending) emitNow();
		};
		// One execution-wide timer coalesces updates from every parallel nested
		// call. Keeping this global to the Code Mode program prevents each call from
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
		const observeInvocation = (event: CodeModeRegistryActivityEvent): void => {
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
		// A caller may ask for a longer deadline for this one program; the request
		// only ever raises the configured default and stops at the policy ceiling.
		const requestedProgramTimeoutMs =
			typeof options.requestedTimeoutMs === "number" && Number.isFinite(options.requestedTimeoutMs)
				? Math.min(Math.max(1, Math.floor(options.requestedTimeoutMs!)), this.config.executor.maxTimeoutMs)
				: 0;
		const baseTimeoutMs = Math.max(this.config.executor.timeoutMs, requestedProgramTimeoutMs);
		const effectiveTimeoutMs = codeUsesOrchestration(options.code)
			? Math.max(orchestrationTimeoutMs, baseTimeoutMs)
			: baseTimeoutMs;
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
				return Math.max(baseTimeoutMs, requestedTimeoutMs + BLOCKING_HOST_CALL_SLACK_MS);
			}
			return undefined;
		};
		const traceAttempt = async <T>(
			ref: string,
			args: Record<string, unknown>,
			signal: AbortSignal,
			run: (setStage: (stage: CodeModeExecutionFailureStageV1) => void) => T | Promise<T>,
		): Promise<T> => {
			const operation = traceRecorder.issueCall(ref, args);
			let stage: CodeModeExecutionFailureStageV1 = "invoke";
			try {
				const value = await run((nextStage) => {
					stage = nextStage;
				});
				// The projection allowlist decides what (if anything) of this is kept;
				// handing it the value is what lets a τ operation record its size and
				// outcome instead of an empty row.
				operation.succeed(value);
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
			store: this.store,
			noteState: (note) => {
				stateNotes.push(note);
				emit();
			},
			registryContext: (signal) => ({ ...baseContext, signal }),
			update,
			guardFullCodeRef,
			traceAttempt,
			invokeAction: (ref, args, signal) => invokeAction(ref, args, { ...baseContext, signal }),
		};
		let sandboxResult: CodeModeSandboxResult;
		try {
			const runtime = (this.#runtime ??= new QuickJsRuntime());
			sandboxResult = await runtime.execute(
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
					...(options.payloads ? { payloads: options.payloads } : {}),
					// Allowlisted env snapshot injected as the guest's `process` global.
					process: codeModeProcessSnapshot(options.context.cwd),
					providers: this.registry
						.providers()
						.filter((provider) => effectiveFullCodeMode || !this.registry.isFullCodeProvider(provider.name))
						.map((provider) => provider.name),
					hostErrorMetadata: (ref, error) => (ref === "pi.bash" ? piBashExitMetadata(error) : undefined),
					...(options.signal ? { signal: options.signal } : {}),
				},
			);
		} catch (error) {
			const message = String(error);
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
			...(stateNotes.length > 0 ? { stateNotes } : {}),
			...(stateNotes.length > 0 && this.store.size > 0 ? { stateKeys: this.store.keys() } : {}),
		};
	}
}
