/**
 * The subagent pane-lifecycle machine, extracted from the herdr CLI wrapper so
 * it can be unit-tested with a fake probe instead of a live herdr server.
 *
 * It depends only on a small `StatusProbe` port (a blocking `waitUntil` plus a
 * point `peek`), not on herdr or any pane id. `herdr-client.ts` supplies the
 * production adapter (`HerdrClient.statusProbe`); tests supply a scripted fake.
 */

import { type AgentStatus, type AgentWaitResult, type PaneAgentState } from "./herdr-parse.ts";

/**
 * Read-only view of a pane's agent status the lifecycle machine polls. The two
 * operations mirror the two herdr calls the machine needs: a blocking wait until
 * the agent reaches one of `statuses` (or times out / goes away), and a point
 * probe of the current status and pane existence.
 */
export interface StatusProbe {
	waitUntil(statuses: AgentStatus[], timeoutMs: number, signal?: AbortSignal): Promise<AgentWaitResult>;
	peek(): Promise<PaneAgentState>;
}

/**
 * Wait for a subagent to finish its turn, using blocking status waits instead of
 * busy polling. pi's observed lifecycle is `unknown -> idle -> working ->
 * (idle | done)`: it emits a brief `idle` at startup before picking up the task,
 * and when finished a focused pane goes `idle` while a background pane goes
 * `done`. So we first wait for `working` (skipping the startup `idle`), then wait
 * for `idle` or `done`.
 *
 * A resolved wait is NOT a turn boundary: herdr cannot see turns, and a pi pane
 * also reads as `idle` in the gap between a tool result and the next model
 * stream. Callers must confirm the turn ended from the child transcript (see
 * `herdr-completion.ts`) and re-arm this wait on a false idle.
 *
 * Termination handling: `waitUntil` reports `not_running` when the pane closes,
 * but it can also report that transiently while pi is still starting up (before
 * it's detected as an agent). To tell those apart we cap each wait at `chunkMs`
 * and re-check pane existence between chunks via `peek`, so a truly closed pane
 * resolves `gone` within ~chunkMs while a starting pane keeps waiting and
 * finishes still resolve instantly.
 */
export async function waitForAgentFinish(
	probe: StatusProbe,
	timeoutMs: number,
	opts?: { signal?: AbortSignal; chunkMs?: number },
): Promise<"finished" | "gone"> {
	const signal = opts?.signal;
	const chunkMs = opts?.chunkMs ?? 20000;
	const deadline = Date.now() + timeoutMs;

	// Phase 1: wait until the agent is actively working, so the startup `idle`
	// isn't mistaken for completion. A very fast background agent may reach `done`
	// before we see `working`; that counts as finished too.
	while (Date.now() < deadline && !signal?.aborted) {
		const remaining = deadline - Date.now();
		const r = await probe.waitUntil(["working", "done"], Math.min(chunkMs, remaining), signal);
		if (r.kind === "gone") return "gone";
		if (r.kind === "reached") {
			if (r.status === "done") return "finished";
			break; // working
		}
		// Chunk elapsed or agent not yet detected: re-check existence / fast-finish.
		const state = await probe.peek();
		if (!state.exists) return "gone";
		if (state.status === "idle" || state.status === "done") return "finished";
		if (state.status === "blocked") break; // active but paused; wait for finish
		// Otherwise still starting (unknown / not_running); keep waiting for `working`.
	}

	// Phase 2: wait for completion. Focused panes go `idle`, background panes go
	// `done`; accept whichever comes first. Re-check existence each chunk so a
	// pane the user terminated is noticed promptly instead of at the full timeout.
	while (Date.now() < deadline && !signal?.aborted) {
		const remaining = deadline - Date.now();
		const r = await probe.waitUntil(["idle", "done"], Math.min(chunkMs, remaining), signal);
		if (r.kind === "reached") return "finished";
		if (r.kind === "gone") return "gone";
		// Chunk timeout or agent no longer detected: confirm the pane is still alive
		// before waiting again. A gone pane resolves `gone`; an idle/done one finishes.
		const state = await probe.peek();
		if (!state.exists) return "gone";
		if (state.status === "done" || state.status === "idle") return "finished";
	}
	return "finished";
}

/**
 * Does a pane actually have a live child in it?
 *
 * Asked after `herdr agent start` reports a startup timeout, which is not
 * evidence either way (see `isAgentStartupTimeoutError`). Two things count as
 * evidence of a child: the transcript file the parent named for it exists (the
 * child's pi wrote to it, so it is running), or herdr reports the pane's agent
 * in a real state. A pane that no longer exists is conclusive the other way.
 *
 * Bounded and cheap: a pane with no child in it resolves `absent` at the
 * deadline, which is the failure path anyway.
 */
export async function waitForChildEvidence(opts: {
	probe: StatusProbe;
	/** Whether the child has written anything to its transcript yet. */
	transcriptExists: () => boolean;
	timeoutMs: number;
	intervalMs?: number;
	signal?: AbortSignal;
}): Promise<"alive" | "absent"> {
	const intervalMs = opts.intervalMs ?? 500;
	const deadline = Date.now() + opts.timeoutMs;
	const live = new Set(["working", "idle", "blocked", "done"]);
	for (;;) {
		if (opts.signal?.aborted) return "absent";
		if (opts.transcriptExists()) return "alive";
		const state = await opts.probe.peek();
		if (!state.exists) return "absent";
		if (state.status && live.has(state.status)) return "alive";
		if (Date.now() >= deadline) return "absent";
		await new Promise<void>((resolve) =>
			setTimeout(resolve, Math.min(intervalMs, Math.max(0, deadline - Date.now()))),
		);
	}
}
