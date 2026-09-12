/**
 * Cross-extension bridge: record a capability finding in the active night run's
 * journal (see `night-mode/capability-journal.ts`).
 *
 * Spindle is where the runner's own faults are observed, and night-mode is where
 * the run's memory lives, so the finding has to cross. The dependency direction
 * is the same as `night-workspace.ts`: spindle reads night-mode, never the
 * reverse, and everything is a no-op outside a night run.
 */

import { appendCapability, type CapabilityState } from "../../night-mode/capability-journal.ts";
import { readActiveNightRun } from "../../night-mode/night-run.ts";

/** Best effort: a journal that cannot be written must not fail a run. */
export function recordNightCapability(capability: string, state: CapabilityState, detail?: string): void {
	const path = readActiveNightRun()?.capabilityPath;
	if (!path) return;
	appendCapability(path, { at: Date.now(), capability, state, ...(detail ? { detail } : {}) });
}
