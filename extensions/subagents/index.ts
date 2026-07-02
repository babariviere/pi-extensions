/**
 * subagents extension for pi
 *
 * Discovers custom agent markdown files (~/.pi/agent/agents/**, <cwd>/.pi/agents/**)
 * and exposes a `subagent` tool the model can call to list agents or run one or
 * several of them. Runs headlessly when not in herdr, or as live panes in a
 * dedicated "subagents" herdr tab when in herdr. Results come back through
 * per-run output files persisted next to the parent pi session file (temp dir
 * fallback when there is no session), pruned by a throttled cleanup sweep.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { cleanupOldRuns } from "./paths.ts";
import { createSubagentTool, type SessionRef } from "./tool.ts";

export default function (pi: ExtensionAPI) {
	const sessionRef: SessionRef = {
		sessionId: undefined,
		sessionFile: undefined,
		cwd: process.cwd(),
	};

	pi.on("session_start", (_event, ctx) => {
		try {
			sessionRef.sessionId = ctx?.sessionManager?.getSessionId?.() || undefined;
		} catch {
			sessionRef.sessionId = undefined;
		}
		try {
			sessionRef.sessionFile = ctx?.sessionManager?.getSessionFile?.() || undefined;
		} catch {
			sessionRef.sessionFile = undefined;
		}
		sessionRef.cwd = ctx?.cwd || process.cwd();

		// Throttled, best-effort prune of stale persisted runs so they do not
		// accumulate forever next to the parent sessions.
		try {
			cleanupOldRuns(sessionRef.sessionFile);
		} catch {
			// Cleanup is housekeeping; never let it break session startup.
		}
	});

	pi.registerTool(createSubagentTool(() => sessionRef));
}
