/**
 * Event-bus contract for hosts that display subagents (for example a desktop app embedding Pi).
 * The model-facing API stays the single `subagent` tool; these events never reach the model.
 */

/** Emitted with a full {@link SubagentHostSnapshot} after every change, and on request. */
export const SUBAGENTS_SNAPSHOT_EVENT = "subagents:snapshot";
/** Ask the extension to emit a fresh snapshot now. No payload. */
export const SUBAGENTS_REQUEST_SNAPSHOT_EVENT = "subagents:request-snapshot";
/** Host command: {@link SubagentHostCommand}. Answered by exactly one command result. */
export const SUBAGENTS_COMMAND_EVENT = "subagents:command";
/** {@link SubagentHostCommandResult} for one command request ID. */
export const SUBAGENTS_COMMAND_RESULT_EVENT = "subagents:command-result";

/** Display data for one named subagent. Never includes answer text or private policy. */
export interface SubagentHostEntry {
	name: string;
	state: "working" | "idle";
	/** The spawn message. */
	task: string;
	/** Epoch milliseconds. */
	createdAt: number;
	/** Canonical working directory pinned at spawn. */
	cwd: string;
	/** "provider/modelId" pinned at spawn. */
	model?: string;
	/** Private durable directory containing the child's `runs.sqlite`. Hosts may only read it. */
	storage: string;
	/** Child conversation inside `runs.sqlite`, once the worker has started. */
	conversationId?: string;
	/** Latest completed answer identity; the text stays available through named status. */
	lastAnswerId?: string;
	error?: string;
	/** A night conversation retired at a host lifecycle boundary. It cannot accept new messages. */
	retired?: boolean;
}

export interface SubagentHostSnapshot {
	agents: SubagentHostEntry[];
}

export type SubagentHostCommand =
	| { requestId: string; action: "send"; name: string; message: string; followUp?: boolean }
	| { requestId: string; action: "stop"; name: string };

export interface SubagentHostCommandResult {
	requestId: string;
	ok: boolean;
	error?: string;
}
