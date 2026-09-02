/**
 * herdr run completion: decide when a run's turn is done, and why.
 *
 * Only the herdr adapter uses this. It waits on a blocking `herdr agent wait`
 * (idle-after-working, or pane gone), passed in as `agentSignal`. The headless
 * adapter has no equivalent — it just waits for its child process to exit — so
 * this completion machinery is herdr-only by design and lives here rather than
 * in the shared `run.ts` seam.
 */

import { statSync } from "node:fs";

interface Snapshot {
	exists: boolean;
	size: number;
	mtimeMs: number;
}

function snapshot(path: string): Snapshot {
	try {
		const st = statSync(path);
		return { exists: true, size: st.size, mtimeMs: st.mtimeMs };
	} catch {
		return { exists: false, size: 0, mtimeMs: 0 };
	}
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isStable(a: Snapshot, b: Snapshot): boolean {
	return a.exists && b.exists && a.size === b.size && a.mtimeMs === b.mtimeMs && b.size > 0;
}

/**
 * Why a run finished waiting:
 * - `stable`   the output file appeared and stopped changing (success path)
 * - `finished` the agent went idle/exited without producing a stable file
 * - `gone`     the pane vanished (e.g. the user terminated the subagent)
 * - `timeout`  none of the above happened before the deadline
 */
export type RunOutcome = "stable" | "finished" | "gone" | "timeout";

export interface RunCompletionOptions {
	timeoutMs: number;
	intervalMs?: number;
	graceMs?: number;
	/** Blocking "idle-after-working or pane-gone" wait for the child. */
	agentSignal?: Promise<"finished" | "gone">;
	/**
	 * Start another such wait after a false idle. Without it, an idle report that
	 * does not line up with a finished turn ends the run as `finished`.
	 */
	rearmAgentSignal?: () => Promise<"finished" | "gone">;
	/**
	 * Whether the child transcript ends on a terminal assistant message, i.e. the
	 * turn actually ended. Defaults to trusting the agent signal.
	 */
	isTurnComplete?: () => boolean;
}

/**
 * Wait for a herdr run to complete.
 *
 * File stability is NOT a completion signal on its own: the file being watched
 * is the child transcript, which pauses mid-turn while the model generates, and
 * a pause must not be mistaken for done. Neither is the agent status: herdr
 * cannot see turn boundaries, and a pi pane reads as `idle` in the gap between a
 * tool result and the next model stream. So completion needs both — an idle/gone
 * signal AND a transcript that ends on a terminal assistant message.
 *
 * Once the agent signals idle we allow a short grace for the final message to
 * flush, extended while the transcript keeps growing (the child is demonstrably
 * alive), preferring `stable` if it settles on a finished turn, else `finished`.
 * An idle signal over an unfinished turn is a false idle: the wait is re-armed
 * via `rearmAgentSignal` instead of cutting the child off. A terminated pane is
 * `gone`. Absent a signal (a degenerate case the herdr adapter avoids), the wait
 * simply runs to `timeout`.
 */
export async function waitForRunCompletion(path: string, opts: RunCompletionOptions): Promise<RunOutcome> {
	const interval = opts.intervalMs ?? 400;
	const grace = opts.graceMs ?? 2500;
	const deadline = Date.now() + opts.timeoutMs;
	const turnComplete = () => opts.isTurnComplete?.() ?? true;

	let signal: "finished" | "gone" | undefined;
	const track = (pending: Promise<"finished" | "gone">): void => {
		pending
			.then((s) => {
				signal = s;
			})
			.catch(() => {});
	};
	if (opts.agentSignal) track(opts.agentSignal);

	while (Date.now() < deadline) {
		await sleep(interval);
		// Wait for the agent itself; ignore mid-turn transcript pauses.
		if (signal === "gone") return "gone";
		if (signal !== "finished") continue;

		const settled = await waitForFlush(path, { deadline, interval, grace, turnComplete });
		if (settled) return settled;
		// False idle: the agent looked done but the transcript is mid-turn. Re-arm
		// rather than finalize, so the caller does not tear the pane down.
		if (!opts.rearmAgentSignal) return "finished";
		signal = undefined;
		track(opts.rearmAgentSignal());
	}
	return "timeout";
}

/**
 * Grace window after an idle signal: let the transcript's final message flush.
 * Returns `stable` when it settles on a finished turn, `finished` when the
 * window elapses on a finished turn, or undefined when the turn is unfinished
 * (a false idle the caller should re-arm). The window is extended whenever the
 * transcript grows, bounded by the run deadline, because growth proves the child
 * is still working.
 */
async function waitForFlush(
	path: string,
	opts: { deadline: number; interval: number; grace: number; turnComplete: () => boolean },
): Promise<"stable" | "finished" | undefined> {
	let graceDeadline = Math.min(opts.deadline, Date.now() + opts.grace);
	let prev = snapshot(path);
	while (Date.now() < graceDeadline) {
		await sleep(opts.interval);
		const cur = snapshot(path);
		if (isStable(prev, cur)) return opts.turnComplete() ? "stable" : undefined;
		const grew = cur.exists && (cur.size !== prev.size || cur.mtimeMs !== prev.mtimeMs);
		prev = cur;
		if (grew) graceDeadline = Math.min(opts.deadline, Date.now() + opts.grace);
	}
	return opts.turnComplete() ? "finished" : undefined;
}

/** Human-readable reason a herdr run failed, derived from its outcome. */
export function outcomeError(outcome: RunOutcome): string {
	switch (outcome) {
		case "gone":
			return "the subagent pane was terminated before it produced a final message";
		case "finished":
			return "the subagent finished (went idle) without producing a final message";
		case "timeout":
			return "the subagent did not finish before timeout";
		default:
			return "the subagent produced no usable output";
	}
}
