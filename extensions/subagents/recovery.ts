/** Recovery inputs contain prompts and policy, never resolved credentials or the ambient environment. */
import type { AgentWorkspace } from "../night-mode/agent-workspace.ts";
import type { RunContext, RunRequest } from "./run.ts";

export const DURABLE_PAUSE_REASON = "pi.subagents.pause";

export interface RecoveryPayload {
	requests: RunRequest[];
	context: Pick<
		RunContext,
		"cwd" | "sessionId" | "sessionFile" | "runId" | "projectTrusted" | "timeoutMs" | "nightRun"
	>;
	workspaces: AgentWorkspace[];
	/** Wall-clock deadline survives process restarts. */
	deadlineAt: number;
}
