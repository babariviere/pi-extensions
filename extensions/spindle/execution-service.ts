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
import type { SpindleToolGate } from "./core/tool-allowlist.ts";
import { redactRecordedArgs } from "./core/arg-redaction.ts";
import { spindleProcessSnapshot } from "./env-snapshot.ts";
import {
  codeUsesOrchestration,
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
  runtimeDependencies ??= Promise.all([
    import("./runtime/quickjs-runtime.ts"),
    import("./runtime/type-checker.ts"),
    import("./runtime/guest-types.ts"),
  ]).then(([quickjs, checker, guest]) => ({
    QuickJsRuntime: quickjs.QuickJsRuntime,
    typeCheckSpindleCode: checker.typeCheckSpindleCode,
    guestTypeDeclarations: guest.guestTypeDeclarations,
  }));

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
        .map((error) =>
          error.line > 0 ? `L${error.line}:${error.column} ${error.message}` : error.message,
        )
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
      const requested = requestedBlockingTimeoutMs(ref, args);
      if (isBlockingOrchestrationRef(ref)) {
        const requestedTimeoutMs =
          requested > 0
            ? Math.max(
                MIN_AGENT_TIMEOUT_MS,
                Math.min(Math.floor(requested), MAX_AGENT_TIMEOUT_MS),
              )
            : 0;
        return Math.max(orchestrationTimeoutMs, requestedTimeoutMs);
      }
      // A blocking host call with an explicit timeout (pi.bash) owns its own
      // deadline: extend the sandbox past it, plus slack, so the call reports
      // its own timeout instead of the executor killing the whole program.
      if (isBlockingHostTimeoutRef(ref) && requested > 0) {
        const requestedTimeoutMs = Math.min(
          Math.floor(requested),
          MAX_AGENT_TIMEOUT_MS,
        );
        return Math.max(
          this.config.executor.timeoutMs,
          requestedTimeoutMs + BLOCKING_HOST_CALL_SLACK_MS,
        );
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
        traceOperation.fail(
          "guard",
          error,
          executionOutcomeFromError(error, callContext.signal),
        );
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
    let sandboxResult: SpindleSandboxResult;
    try {
      this.#runtime ??= new dependencies.QuickJsRuntime();
      sandboxResult = await this.#runtime.execute(
        options.code,
        async (ref, args, runtimeSignal) => {
          const callContext = { ...baseContext, signal: runtimeSignal };
          switch (ref) {
            case "spindle.$providers":
              return traceAttempt(
                "spindle.discovery.providers",
                args,
                runtimeSignal,
                () =>
                  this.registry
                    .providers()
                    .filter(
                      (provider) => effectiveFullCodeMode || !fullCodeProvider(provider.name),
                    ),
              );
            case "spindle.$catalog":
              return traceAttempt(
                "spindle.discovery.catalog",
                args,
                runtimeSignal,
                async (setStage) => {
                  const provider = typeof args.provider === "string" ? args.provider : undefined;
                  setStage("guard");
                  if (provider) guardFullCodeRef(`${provider}.*`);
                  setStage(provider && !this.registry.has(provider) ? "resolve" : "invoke");
                  return this.registry.catalog(callContext, {
                    ...(provider ? { provider } : {}),
                    ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
                    includeProvider: (name) => effectiveFullCodeMode || !fullCodeProvider(name),
                  });
                },
              );
            case "spindle.$list":
              return traceAttempt(
                "spindle.discovery.list",
                args,
                runtimeSignal,
                async (setStage) => {
                  setStage("guard");
                  if (typeof args.provider === "string") guardFullCodeRef(`${args.provider}.*`);
                  setStage(
                    typeof args.provider === "string" && !this.registry.has(args.provider)
                      ? "resolve"
                      : "invoke",
                  );
                  const actions = await this.registry.list(
                    {
                      ...(typeof args.provider === "string" ? { provider: args.provider } : {}),
                      ...(typeof args.namespace === "string" ? { namespace: args.namespace } : {}),
                      ...(typeof args.query === "string" ? { query: args.query } : {}),
                      ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
                    },
                    callContext,
                  );
                  return actions.filter(
                    (action) => effectiveFullCodeMode || !fullCodeProvider(action.provider),
                  );
                },
              );
            case "spindle.$search":
              return traceAttempt(
                "spindle.discovery.search",
                args,
                runtimeSignal,
                async () => {
                  const actions = await this.registry.search(
                    String(args.query ?? ""),
                    callContext,
                    typeof args.limit === "number" ? args.limit : undefined,
                  );
                  return actions.filter(
                    (action) => effectiveFullCodeMode || !fullCodeProvider(action.provider),
                  );
                },
              );
            case "spindle.$describe":
              return traceAttempt(
                "spindle.discovery.describe",
                args,
                runtimeSignal,
                async (setStage) => {
                  const targetRef = String(args.ref ?? "");
                  setStage("guard");
                  guardFullCodeRef(targetRef);
                  setStage("resolve");
                  return this.registry.describe(targetRef, callContext);
                },
              );
            case "spindle.$call": {
              const callArgs =
                typeof args.args === "object" && args.args !== null && !Array.isArray(args.args)
                  ? (args.args as Record<string, unknown>)
                  : {};
              const targetRef = String(args.ref ?? "");
              return invokeAction(targetRef, callArgs, callContext);
            }
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
