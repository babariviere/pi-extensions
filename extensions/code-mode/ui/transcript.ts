import { TranscriptAccumulator } from "./transcript-parser.ts";
import { recordOf } from "./transcript-sanitization.ts";

type CodeModeTranscriptEntryStatus = "running" | "completed" | "failed";

export interface CodeModeTranscriptEntry {
	id: string;
	kind: "user" | "assistant" | "tool" | "error" | "status";
	label: string;
	text?: string;
	status?: CodeModeTranscriptEntryStatus;
	toolName?: string;
	args?: Record<string, unknown>;
	result?: unknown;
	parentId?: string;
	depth?: number;
}

export interface CodeModeAgentTranscript {
	entries: CodeModeTranscriptEntry[];
	/** Kept for compatibility; true means older pages are available. */
	truncated: boolean;
	hasMore?: boolean;
	hasNewer?: boolean;
	updatedAt?: number;
}

export interface CodeModeTranscriptSource {
	id: string;
	status: string;
	logFile?: string;
}

export interface CodeModeNestedToolPreview {
	kind: "code-mode-agent-tools";
	id: string;
	name: string;
	status: string;
	runner?: "pi" | "claude";
	owner: "agent" | "actor";
	text?: string;
	tools: CodeModeTranscriptEntry[];
}

export const projectAgentTranscript = (
	events: Array<Record<string, unknown>>,
	olderAvailable = false,
): CodeModeAgentTranscript => {
	const accumulator = new TranscriptAccumulator();
	accumulator.append(events);
	return accumulator.snapshot(olderAvailable);
};

export const isCodeModeNestedToolPreview = (value: unknown): value is CodeModeNestedToolPreview => {
	const record = recordOf(value);
	return (
		record?.kind === "code-mode-agent-tools" &&
		typeof record.id === "string" &&
		typeof record.name === "string" &&
		(record.text === undefined || typeof record.text === "string") &&
		Array.isArray(record.tools)
	);
};

export const recentTranscriptTools = (transcript: CodeModeAgentTranscript, limit = 2): CodeModeTranscriptEntry[] => {
	const tools = transcript.entries.filter((entry) => entry.kind === "tool");
	const boundedLimit = Math.max(1, limit);
	const running = tools.filter((entry) => entry.status === "running");
	const completed = tools.filter((entry) => entry.status !== "running");
	const completedSlots = Math.max(0, boundedLimit - Math.min(running.length, boundedLimit));
	const retained = new Set([...running.slice(-boundedLimit), ...completed.slice(-completedSlots)]);
	return tools
		.filter((entry) => retained.has(entry))
		.slice(-boundedLimit)
		.map((entry) => ({ ...entry }));
};
