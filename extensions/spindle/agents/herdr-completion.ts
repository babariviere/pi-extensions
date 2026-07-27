/**
 * herdr run completion: decide when a run's turn is done, and why.
 *
 * Only the herdr adapter uses this. It races the child transcript settling
 * against a blocking `herdr agent wait` (idle-after-working, or pane gone),
 * passed in as `agentSignal`. The headless adapter has no equivalent — it just
 * waits for its child process to exit — so this completion machinery is
 * herdr-only by design and lives here rather than in the shared `run.ts` seam.
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

/**
 * Wait for a herdr run to complete.
 *
 * The `agentSignal` is a blocking "idle-after-working or pane-gone" wait; the
 * agent finishing its turn IS completion. File stability is NOT used as a
 * completion signal: the file being watched is the child transcript, which
 * pauses mid-turn while the model generates, and a pause must not be mistaken
 * for done. Once the agent finishes we allow a short grace for the transcript's
 * final message to flush, preferring `stable` if it settles within the window,
 * else `finished`. A terminated pane is `gone`. Absent a signal (a degenerate
 * case the herdr adapter avoids), the wait simply runs to `timeout`.
 */
export async function waitForRunCompletion(
	path: string,
	opts: {
		timeoutMs: number;
		intervalMs?: number;
		graceMs?: number;
		agentSignal?: Promise<"finished" | "gone">;
	},
): Promise<RunOutcome> {
	const interval = opts.intervalMs ?? 400;
	const grace = opts.graceMs ?? 2500;
	const deadline = Date.now() + opts.timeoutMs;

	let signal: "finished" | "gone" | undefined;
	opts.agentSignal
		?.then((s) => {
			signal = s;
		})
		.catch(() => {});

	while (Date.now() < deadline) {
		await sleep(interval);
		// Wait for the agent itself; ignore mid-turn transcript pauses. Once the
		// blocking wait fires, resolve the outcome.
		if (signal === "gone") return "gone";
		if (signal === "finished") {
			// Grace: let the final message flush; prefer 'stable' if it settles.
			const graceDeadline = Math.min(deadline, Date.now() + grace);
			let gp = snapshot(path);
			while (Date.now() < graceDeadline) {
				await sleep(interval);
				const gc = snapshot(path);
				if (isStable(gp, gc)) return "stable";
				gp = gc;
			}
			return "finished";
		}
	}
	return "timeout";
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
