/** Common lifecycle surface for session-local and durable run books. */
import type {
	AgentBatchRegistration,
	AgentBatchSnapshot,
	AgentCompletionSink,
	AgentWaitOutcome,
} from "./agent-run-book.ts";

export interface AgentRuns {
	setAnnounceWhen(ready: () => boolean): void;
	setSink(sink: AgentCompletionSink | undefined): void;
	flushCompletions(): void | Promise<void>;
	register(registration: AgentBatchRegistration): void | Promise<void>;
	wait(runId: string, waitMs: number): Promise<AgentWaitOutcome>;
	list(): AgentBatchSnapshot[] | Promise<AgentBatchSnapshot[]>;
	cancel(runId?: string): string[] | Promise<string[]>;
	drain(timeoutMs: number): Promise<boolean>;
	/** Drop observer/turn links without cancelling runs, used only for durable reload. */
	suspend?(): void | Promise<void>;
}
