import { TranscriptAccumulator } from "./transcript-parser.ts";
import { recordOf } from "./transcript-sanitization.ts";

type SpindleTranscriptEntryStatus = "running" | "completed" | "failed";

export interface SpindleTranscriptEntry {
  id: string;
  kind: "user" | "assistant" | "tool" | "error" | "status";
  label: string;
  text?: string;
  status?: SpindleTranscriptEntryStatus;
  toolName?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  parentId?: string;
  depth?: number;
}

export interface SpindleAgentTranscript {
  entries: SpindleTranscriptEntry[];
  /** Kept for compatibility; true means older pages are available. */
  truncated: boolean;
  hasMore?: boolean;
  hasNewer?: boolean;
  updatedAt?: number;
}

export interface SpindleTranscriptSource {
  id: string;
  status: string;
  logFile?: string;
}

export interface SpindleNestedToolPreview {
  kind: "spindle-agent-tools";
  id: string;
  name: string;
  status: string;
  runner?: "pi" | "claude";
  owner: "agent" | "actor";
  text?: string;
  tools: SpindleTranscriptEntry[];
}

export const projectAgentTranscript = (
  events: Array<Record<string, unknown>>,
  olderAvailable = false,
): SpindleAgentTranscript => {
  const accumulator = new TranscriptAccumulator();
  accumulator.append(events);
  return accumulator.snapshot(olderAvailable);
};

export const isSpindleNestedToolPreview = (value: unknown): value is SpindleNestedToolPreview => {
  const record = recordOf(value);
  return (
    record?.kind === "spindle-agent-tools" &&
    typeof record.id === "string" &&
    typeof record.name === "string" &&
    (record.text === undefined || typeof record.text === "string") &&
    Array.isArray(record.tools)
  );
};

export const recentTranscriptTools = (
  transcript: SpindleAgentTranscript,
  limit = 2,
): SpindleTranscriptEntry[] => {
  const tools = transcript.entries.filter((entry) => entry.kind === "tool");
  const boundedLimit = Math.max(1, limit);
  const running = tools.filter((entry) => entry.status === "running");
  const completed = tools.filter((entry) => entry.status !== "running");
  const completedSlots = Math.max(0, boundedLimit - Math.min(running.length, boundedLimit));
  const retained = new Set([
    ...running.slice(-boundedLimit),
    ...completed.slice(-completedSlots),
  ]);
  return tools
    .filter((entry) => retained.has(entry))
    .slice(-boundedLimit)
    .map((entry) => ({ ...entry }));
};

