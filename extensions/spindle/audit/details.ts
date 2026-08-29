import {
  isSpindleExecutionTraceV1,
  type SpindleExecutionTraceOperationV1,
  type SpindleExecutionTraceV1,
} from "./trace.ts";

export const SPINDLE_EXECUTION_DETAILS_MAX_BYTES = 512 * 1024;

/** One type-check failure, as reported to the model and rendered in the TUI. */
export interface SpindleRenderTypeError {
  line: number;
  column: number;
  message: string;
}

const MAX_PERSISTED_TYPE_ERRORS = 50;
const MAX_TYPE_ERROR_MESSAGE_CHARS = 500;

export interface SpindlePersistedExecutionDetailsV1 {
  success: boolean;
  trace: SpindleExecutionTraceV1;
  outputFormat?: "yaml" | "json";
  outputFormatStartLine?: number;
  outputFormatLines?: number;
  /** Present when the program failed type checking and was never executed. */
  typeErrors?: SpindleRenderTypeError[];
}

export interface SpindleLegacyRenderAudit {
  ref: string;
  tool?: string;
  provider?: string;
  success?: boolean;
  error?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  resultTruncated?: boolean;
  preview?: unknown;
  startedAt?: number;
  endedAt?: number;
}

export interface SpindleExecutionRenderDetails {
  success?: boolean;
  error?: string;
  progress?: string;
  outputFormat?: "yaml" | "json";
  outputFormatStartLine?: number;
  outputFormatLines?: number;
  phases: string[];
  audits: SpindleLegacyRenderAudit[];
  typeErrors?: SpindleRenderTypeError[];
}

const serializedBytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value), "utf8");

const cloneTrace = (trace: SpindleExecutionTraceV1): SpindleExecutionTraceV1 =>
  structuredClone(trace);

/**
 * Creates the only object stored in final spindle_exec details. Rich call
 * audits remain available to live partial rendering but are deliberately not
 * copied here. The aggregate object, not each member independently, is bound.
 */
export const createSpindlePersistedExecutionDetails = (input: {
  success: boolean;
  trace: SpindleExecutionTraceV1;
  outputFormat?: "yaml" | "json";
  outputFormatStartLine?: number;
  outputFormatLines?: number;
  typeErrors?: SpindleRenderTypeError[];
}): SpindlePersistedExecutionDetailsV1 => {
  const details: SpindlePersistedExecutionDetailsV1 = {
    success: input.success,
    trace: cloneTrace(input.trace),
    ...(input.outputFormat ? { outputFormat: input.outputFormat } : {}),
    ...(input.outputFormatStartLine !== undefined
      ? { outputFormatStartLine: Math.max(0, Math.floor(input.outputFormatStartLine)) }
      : {}),
    ...(input.outputFormatLines !== undefined
      ? { outputFormatLines: Math.max(0, Math.floor(input.outputFormatLines)) }
      : {}),
    ...(input.typeErrors !== undefined && input.typeErrors.length > 0
      ? {
          typeErrors: input.typeErrors
            .slice(0, MAX_PERSISTED_TYPE_ERRORS)
            .map((error) => ({
              line: Math.max(0, Math.floor(error.line)),
              column: Math.max(0, Math.floor(error.column)),
              message: error.message.slice(0, MAX_TYPE_ERROR_MESSAGE_CHARS),
            })),
        }
      : {}),
  };
  while (
    serializedBytes(details) > SPINDLE_EXECUTION_DETAILS_MAX_BYTES &&
    details.trace.operations.length > 0
  ) {
    details.trace.operations.pop();
    details.trace.counts.droppedOperations++;
  }
  while (
    serializedBytes(details) > SPINDLE_EXECUTION_DETAILS_MAX_BYTES &&
    details.trace.phases.length > 0
  ) {
    details.trace.phases.pop();
    details.trace.counts.droppedValues++;
  }
  while (
    serializedBytes(details) > SPINDLE_EXECUTION_DETAILS_MAX_BYTES &&
    details.typeErrors !== undefined &&
    details.typeErrors.length > 0
  ) {
    details.typeErrors.pop();
  }
  if (serializedBytes(details) > SPINDLE_EXECUTION_DETAILS_MAX_BYTES) {
    delete details.trace.error;
    details.trace.counts.droppedValues++;
  }
  return details;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const legacyAudit = (value: unknown): SpindleLegacyRenderAudit | undefined => {
  if (!isRecord(value) || typeof value.ref !== "string") return undefined;
  return {
    ref: value.ref,
    ...(typeof value.tool === "string" ? { tool: value.tool } : {}),
    ...(typeof value.provider === "string" ? { provider: value.provider } : {}),
    ...(typeof value.success === "boolean" ? { success: value.success } : {}),
    ...(typeof value.error === "string" ? { error: value.error } : {}),
    ...(isRecord(value.args) ? { args: value.args } : {}),
    ...(value.result !== undefined ? { result: value.result } : {}),
    ...(typeof value.resultTruncated === "boolean"
      ? { resultTruncated: value.resultTruncated }
      : {}),
    ...(value.preview !== undefined ? { preview: value.preview } : {}),
    ...(typeof value.startedAt === "number" ? { startedAt: value.startedAt } : {}),
    ...(typeof value.endedAt === "number" ? { endedAt: value.endedAt } : {}),
  };
};

const auditFromOperation = (
  operation: SpindleExecutionTraceOperationV1,
): SpindleLegacyRenderAudit => ({
  ref: operation.ref,
  ...(operation.action ? { tool: operation.action } : {}),
  ...(operation.provider ? { provider: operation.provider } : {}),
  success: operation.outcome === "succeeded",
  ...(operation.error ? { error: operation.error } : {}),
  ...(Object.keys(operation.args).length > 0 ? { args: operation.args } : {}),
  ...(operation.result !== undefined ? { result: operation.result } : {}),
});

/**
 * Adapts both old audit-bearing session details and current trace-only details
 * for rendering. Legacy audits win when present so old transcripts retain
 * their historical rich previews.
 */
export const readSpindleExecutionRenderDetails = (
  value: unknown,
): SpindleExecutionRenderDetails => {
  if (!isRecord(value)) return { audits: [], phases: [] };
  const trace = isSpindleExecutionTraceV1(value.trace) ? value.trace : undefined;
  const oldAudits = Array.isArray(value.audits)
    ? value.audits.map(legacyAudit).filter((audit): audit is SpindleLegacyRenderAudit => audit !== undefined)
    : undefined;
  const oldPhases = Array.isArray(value.phases)
    ? value.phases.filter((phase): phase is string => typeof phase === "string")
    : undefined;
  return {
    ...(typeof value.success === "boolean"
      ? { success: value.success }
      : trace
        ? { success: trace.outcome === "succeeded" }
        : {}),
    ...(typeof value.error === "string"
      ? { error: value.error }
      : trace?.error
        ? { error: trace.error }
        : {}),
    ...(typeof value.progress === "string" ? { progress: value.progress } : {}),
    ...(value.outputFormat === "yaml" || value.outputFormat === "json"
      ? { outputFormat: value.outputFormat }
      : {}),
    ...(typeof value.outputFormatStartLine === "number" &&
      Number.isFinite(value.outputFormatStartLine) &&
      value.outputFormatStartLine >= 0
      ? { outputFormatStartLine: Math.floor(value.outputFormatStartLine) }
      : {}),
    ...(typeof value.outputFormatLines === "number" &&
      Number.isFinite(value.outputFormatLines) &&
      value.outputFormatLines >= 0
      ? { outputFormatLines: Math.floor(value.outputFormatLines) }
      : {}),
    phases: oldPhases ?? trace?.phases ?? [],
    audits: oldAudits ?? trace?.operations.map(auditFromOperation) ?? [],
    ...(Array.isArray(value.typeErrors)
      ? {
          typeErrors: value.typeErrors
            .filter(
              (error): error is SpindleRenderTypeError =>
                typeof error === "object" &&
                error !== null &&
                !Array.isArray(error) &&
                typeof (error as SpindleRenderTypeError).line === "number" &&
                typeof (error as SpindleRenderTypeError).column === "number" &&
                typeof (error as SpindleRenderTypeError).message === "string",
            )
            .slice(0, MAX_PERSISTED_TYPE_ERRORS),
        }
      : {}),
  };
};
