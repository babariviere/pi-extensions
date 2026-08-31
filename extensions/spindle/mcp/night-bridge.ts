/**
 * Cross-extension bridge: does the active night run demand read-only MCP?
 *
 * Same shape and same one-way dependency as `sandbox/night-bridge.ts`: spindle
 * reads the night-mode handshake file, never the reverse. A file rather than the
 * event bus because subagents are separate `pi` processes, so an in-memory
 * channel would never reach them, and the guard has to cover subagents most of
 * all: the orchestrator is the one being watched, the children are not.
 */

import { isNightRunParticipant, readActiveNightRun } from "../../night-mode/night-run.ts";

/** Identity of the session asking, used to tell participants from bystanders. */
export interface NightMcpSessionRef {
	sessionId?: string | undefined;
	cwd?: string | undefined;
}

/**
 * True when this process belongs to a night run that asked for read-only MCP.
 * A session the user opens while a run is in flight is a bystander and keeps
 * whatever `spindle.json` configures.
 */
export function activeNightMcpReadOnly(ref: NightMcpSessionRef = {}): boolean {
	const run = readActiveNightRun();
	if (!run || run.mcp?.readOnly !== true) return false;
	return isNightRunParticipant(run, ref);
}
