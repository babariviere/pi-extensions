/** Host-only transport. The model-facing API is the single subagent tool. */
import type { RunContext, RunRequest } from "./run.ts";

export interface LastAnswer {
	id: string;
	text: string;
}
export interface WorkerStatus {
	conversationId: string;
	working: boolean;
	lastAnswer?: LastAnswer;
}
export interface WorkerAnswer {
	ok: boolean;
	answer?: LastAnswer;
	error?: string;
	aborted?: boolean;
}
export interface WorkerSpec {
	name: string;
	request: RunRequest;
	context: Omit<RunContext, "signal" | "onStatus">;
	directory: string;
	/** Commit a recovered stop/expired-cycle abort before resuming any generation. */
	stopOnOpen?: boolean;
}
export type WorkerCommand =
	| { type: "start"; spec: WorkerSpec }
	| { type: "input"; id: string; message: string; followUp: boolean }
	| { type: "stop"; id: string }
	| { type: "status"; id: string }
	| { type: "pause" }
	| { type: "cancel" };
export type WorkerPacket =
	| { type: "ready"; status: WorkerStatus }
	| { type: "accepted"; id: string; status: WorkerStatus }
	| { type: "answer"; id: string; result: WorkerAnswer; status: WorkerStatus }
	| { type: "status"; id: string; status: WorkerStatus }
	| { type: "stopped"; id: string; status: WorkerStatus }
	| { type: "paused" }
	| { type: "error"; id?: string; error: string };
