/**
 * subagents extension for pi
 *
 * Discovers custom agent markdown files (~/.pi/agent/agents/**, <cwd>/.pi/agents/**)
 * and exposes a `subagent` tool the model can call to list agents or run one or
 * several of them. Runs headlessly when not in herdr, or as live panes in a
 * dedicated "subagents" herdr tab when in herdr. Results come back through
 * per-run output files under a temp dir keyed by the parent pi session id.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
	});

	pi.registerTool(createSubagentTool(() => sessionRef));
}
