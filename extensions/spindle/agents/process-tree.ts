/**
 * Child-process teardown for the headless backend.
 *
 * A subagent `pi` child spawns its own tool subprocesses (bash, test runners,
 * migrations). Signalling only the direct child leaves those orphaned: they keep
 * running, and keep writing to the working copy, long after the parent stopped
 * waiting. Runs are therefore spawned in their own process group
 * (`detached: true`) and torn down group-wide, SIGTERM first so the child can
 * flush its transcript, then SIGKILL for whatever ignored it.
 */

import type { ChildProcess } from "node:child_process";

/** Grace period between the SIGTERM and the SIGKILL of a teardown. */
export const DEFAULT_KILL_GRACE_MS = 3_000;

/** Seam for tests: how a signal reaches a pid (negative pid = process group). */
export interface ProcessTreeDeps {
	kill?: (pid: number, signal: NodeJS.Signals) => void;
}

/** The child subset this module needs, so tests need no real process. */
export interface KillableChild {
	pid?: number | undefined;
	kill(signal?: NodeJS.Signals): boolean;
	once(event: "close", listener: () => void): unknown;
}

/**
 * Signal a child's whole process group, falling back to the child alone.
 *
 * The group is addressed as `-pid`, which only exists when the child was
 * spawned `detached`. A child that died already (ESRCH) or was never detached
 * makes the group kill throw; the direct kill is then the best available
 * teardown. Never throws.
 */
export function signalProcessTree(
	child: KillableChild,
	signal: NodeJS.Signals,
	deps: ProcessTreeDeps = {},
): void {
	const kill = deps.kill ?? ((pid: number, sig: NodeJS.Signals) => process.kill(pid, sig));
	const pid = child.pid;
	if (pid === undefined) return;
	try {
		kill(-pid, signal);
		return;
	} catch {
		// No process group (not detached, or already reaped): signal the child.
	}
	try {
		child.kill(signal);
	} catch {
		// The child is gone; nothing left to tear down.
	}
}

export interface TerminateHandle {
	/** Cancel the pending SIGKILL escalation (the child exited in time). */
	cancel(): void;
}

/**
 * Tear down a child and its process group. Returns immediately: the caller
 * still resolves the run from the child's `close` event, so a killed run
 * reports whatever output it produced before dying.
 */
export function terminateProcessTree(
	child: KillableChild,
	options: { graceMs?: number; deps?: ProcessTreeDeps } = {},
): TerminateHandle {
	const graceMs = options.graceMs ?? DEFAULT_KILL_GRACE_MS;
	const deps = options.deps ?? {};
	signalProcessTree(child, "SIGTERM", deps);
	const timer = setTimeout(() => signalProcessTree(child, "SIGKILL", deps), graceMs);
	timer.unref?.();
	const cancel = () => clearTimeout(timer);
	child.once("close", cancel);
	return { cancel };
}
