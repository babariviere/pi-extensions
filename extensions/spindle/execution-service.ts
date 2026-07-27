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
import type {
  SpindleActivityEventInput,
  SpindleActivityItemInput,
  SpindlePhaseInput,
  SpindleRunDisplay,
} from "./activity/types.ts";
import {
  MAX_AGENT_TIMEOUT_MS,
  MIN_AGENT_TIMEOUT_MS,
  type SpindleConfig,
} from "./config.ts";
import {
  ActionRegistry,
  type SpindleCallAudit,
  type SpindleRegistryActivityEvent,
} from "./core/action-registry.ts";
import {
  ApprovalController,
  SpindleSessionApprovals,
  type SpindleAutoApprovalAudit,
} from "./core/approval-controller.ts";
import { SpindleAutoApprovalClassifier } from "./core/auto-approval-classifier.ts";
import type { SpindleToolGate } from "./core/tool-allowlist.ts";
import {
  codeUsesOrchestration,
  isBlockingOrchestrationRef,
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
  runtimeDependencies ??= Promise.all([
    import("./runtime/quickjs-runtime.ts"),
    import("./runtime/type-checker.ts"),
    import("./runtime/guest-types.ts"),
  ]).then(([quickjs, checker, guest]) => ({
    QuickJsRuntime: quickjs.QuickJsRuntime,
    typeCheckSpindleCode: checker.typeCheckSpindleCode,
    guestTypeDeclarations: guest.guestTypeDeclarations,
  }));

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

// The installed pi-ai `Usage` has no `reasoning` field (upstream builds
// against a newer pi-ai that does). Model it locally so the passthrough is
// preserved without widening the host types.
type UsageWithReasoning = Usage & { reasoning?: number };

const aggregateUsage = (usages: UsageWithReasoning[]): UsageWithReasoning => ({
  input: usages.reduce((total, usage) => total + usage.input, 0),
  output: usages.reduce((total, usage) => total + usage.output, 0),
  cacheRead: usages.reduce((total, usage) => total + usage.cacheRead, 0),
  cacheWrite: usages.reduce((total, usage) => total + usage.cacheWrite, 0),
  ...(usages.some((usage) => usage.cacheWrite1h !== undefined)
    ? { cacheWrite1h: usages.reduce((total, usage) => total + (usage.cacheWrite1h ?? 0), 0) }
    : {}),
  ...(usages.some((usage) => usage.reasoning !== undefined)
    ? { reasoning: usages.reduce((total, usage) => total + (usage.reasoning ?? 0), 0) }
    : {}),
  totalTokens: usages.reduce((total, usage) => total + usage.totalTokens, 0),
  cost: {
    input: usages.reduce((total, usage) => total + usage.cost.input, 0),
    output: usages.reduce((total, usage) => total + usage.cost.output, 0),
    cacheRead: usages.reduce((total, usage) => total + usage.cost.cacheRead, 0),
    cacheWrite: usages.reduce((total, usage) => total + usage.cost.cacheWrite, 0),
    total: usages.reduce((total, usage) => total + usage.cost.total, 0),
  },
});

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
  readonly #sessionApprovals = new SpindleSessionApprovals();

  constructor(
    readonly registry: ActionRegistry,
    readonly config: SpindleConfig,
    readonly activity?: SpindleActivityStore,
    readonly autoApprovalClassifier = new SpindleAutoApprovalClassifier(),
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
      this.activity?.finish(options.parentToolCallId, false, "Type checking failed");
      return {
        success: false,
        value: undefined,
        logs: [],
        audits: [],
        phases: [],
        trace: traceRecorder.seal("failed", [], "Type checking failed"),
        elapsedMs: performance.now() - startedAt,
        typeErrors: checked.errors,
      };
    }

    const classifierUsages: Usage[] = [];
    const recordAutoDecision = (
      audit: SpindleAutoApprovalAudit,
      decision?: { usage: Usage },
    ): void => {
      const operation = traceRecorder.issueCall("spindle.approval.auto", {
        action: audit.action,
        risk: audit.risk,
      });
      operation.succeed(audit);
      if (decision) classifierUsages.push(decision.usage);
    };
    const approval = new ApprovalController(
      this.config.approvals,
      options.context,
      this.#sessionApprovals,
      this.autoApprovalClassifier,
      recordAutoDecision,
    );
    const audits: SpindleCallAudit[] = [];
    const phases: string[] = [];
    const workflowSpans = new Map<
      string,
      { kind: "parallel" | "pipeline"; operation: SpindleExecutionTraceOperationHandle }
    >();
    let agentCalls = 0;
    const maxAgentCalls = Math.max(
      1,
      Math.min(
        options.maxAgentCalls ?? this.config.agents.maxPerExecution,
        this.config.agents.maxPerExecution,
      ),
    );
    const guardAgentCall = (ref: string): void => {
      if (ref !== "agents.run" && ref !== "agents.runAll") return;
      agentCalls++;
      if (agentCalls > maxAgentCalls) {
        throw new Error(`Spindle agent budget exhausted (${maxAgentCalls} per execution)`);
      }
    };
    const fullCodeProvider = (value: string): "pi" | "extensions" | undefined => {
      const separator = value.indexOf(".");
      const provider = separator > 0 ? value.slice(0, separator) : value;
      return provider === "pi" || provider === "extensions" ? provider : undefined;
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
    const orchestrationTimeoutMs = Math.max(
      this.config.executor.timeoutMs,
      this.config.agents.timeoutMs,
    );
    const effectiveTimeoutMs = codeUsesOrchestration(options.code)
      ? orchestrationTimeoutMs
      : this.config.executor.timeoutMs;
    const minimumTimeoutMsForHostCall = (
      ref: string,
      args: Record<string, unknown>,
    ): number | undefined => {
      const targetRef = ref;
      if (!isBlockingOrchestrationRef(targetRef)) return undefined;
      const targetArgs = args;
      const requestedTimeoutMs =
        targetRef === "agents.run" &&
        typeof targetArgs.timeoutMs === "number" &&
        Number.isFinite(targetArgs.timeoutMs)
          ? Math.max(
              MIN_AGENT_TIMEOUT_MS,
              Math.min(Math.floor(targetArgs.timeoutMs), MAX_AGENT_TIMEOUT_MS),
            )
          : 0;
      return Math.max(orchestrationTimeoutMs, requestedTimeoutMs);
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
      const traceOperation = traceRecorder.issueCall(ref, args);
      try {
        guardFullCodeRef(ref);
        guardAgentCall(ref);
      } catch (error) {
        traceOperation.fail(
          "guard",
          error,
          executionOutcomeFromError(error, callContext.signal),
        );
        throw error;
      }
      return this.registry.invoke(ref, args, {
        ...callContext,
        approve: async (action, preparedArgs) => {
          await approval.approve(action, preparedArgs);
        },
        audits,
        maxResultChars: this.config.executor.maxNestedResultChars,
        traceOperation,
        observeInvocation,
      });
    };
    let sandboxResult: SpindleSandboxResult;
    try {
      this.#runtime ??= new dependencies.QuickJsRuntime();
      sandboxResult = await this.#runtime.execute(
        options.code,
        async (ref, args, runtimeSignal) => {
          const callContext = { ...baseContext, signal: runtimeSignal };
          switch (ref) {
            case "spindle.$progress":
              return traceAttempt(
                "spindle.workflow.progress",
                args,
                runtimeSignal,
                () => update(String(args.message ?? "Working")),
              );
            case "spindle.$configure":
              return traceAttempt(
                "spindle.workflow.configure",
                args,
                runtimeSignal,
                () => {
                  const display: SpindleRunDisplay = {
                    ...(typeof args.name === "string" ? { name: args.name } : {}),
                    ...(typeof args.description === "string" ? { description: args.description } : {}),
                  };
                  return this.activity?.configure(options.parentToolCallId, display) ?? display;
                },
              );
            case "spindle.$phase":
              return traceAttempt(
                "spindle.workflow.phase",
                args,
                runtimeSignal,
                (setStage) => {
                  setStage("validate");
                  const name =
                    typeof args.name === "string" ? args.name.trim() : "";
                  if (!name) throw new Error("Workflow phase name must be a non-empty string");
                  phases.push(name);
                  const phaseIndex = phases.length - 1;
                  const phaseInput: SpindlePhaseInput = {
                    name,
                    ...(typeof args.id === "string" ? { id: args.id } : {}),
                    ...(typeof args.description === "string" ? { description: args.description } : {}),
                    ...(typeof args.total === "number" ? { total: args.total } : {}),
                  };
                  setStage("invoke");
                  const activityPhase = this.activity?.phase(options.parentToolCallId, phaseInput);
                  update(`Phase: ${name}`);
                  return {
                    name,
                    index: phaseIndex,
                    ...(activityPhase ? { id: activityPhase.id } : {}),
                  };
                },
              );
            case "spindle.$item":
              return traceAttempt(
                "spindle.workflow.item",
                args,
                runtimeSignal,
                () => {
                  const item = args as unknown as SpindleActivityItemInput;
                  return this.activity?.upsertItem(options.parentToolCallId, item) ?? item;
                },
              );
            case "spindle.$event":
              return traceAttempt(
                "spindle.workflow.event",
                args,
                runtimeSignal,
                () => {
                  const event = args as unknown as SpindleActivityEventInput;
                  this.activity?.event(options.parentToolCallId, event);
                },
              );
            case "spindle.$spanStart": {
              const id = typeof args.id === "string" ? args.id : "";
              const kind = args.kind;
              if (!id || (kind !== "parallel" && kind !== "pipeline")) {
                throw new Error("Invalid internal workflow span start");
              }
              if (workflowSpans.has(id)) throw new Error("Duplicate internal workflow span");
              const operation = traceRecorder.issueCall(`spindle.workflow.${kind}`, args);
              workflowSpans.set(id, { kind, operation });
              return undefined;
            }
            case "spindle.$spanEnd": {
              const id = typeof args.id === "string" ? args.id : "";
              const span = workflowSpans.get(id);
              if (!span) throw new Error("Unknown internal workflow span");
              workflowSpans.delete(id);
              if (args.outcome === "succeeded") span.operation.succeed(undefined);
              else {
                span.operation.fail(
                  "invoke",
                  undefined,
                  executionOutcomeFromError(new Error("Workflow span failed"), runtimeSignal),
                );
              }
              return undefined;
            }
            default:
              return invokeAction(ref, args, callContext);
          }
        },
        {
          timeoutMs: effectiveTimeoutMs,
          memoryLimitBytes: this.config.executor.memoryLimitBytes,
          maxLogChars: this.config.executor.maxOutputChars,
          minimumTimeoutMsForHostCall,
          ...(checked.javascript ? { transpiledCode: checked.javascript } : {}),
          ...(options.strings ? { strings: options.strings } : {}),
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
      ...(classifierUsages.length > 0
        ? { usage: aggregateUsage(classifierUsages) }
        : {}),
    };
  }
}
