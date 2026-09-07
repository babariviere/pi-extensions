/**
 * Guardrail policy: the pure decision function behind the `tool_call` hook,
 * kept out of index.ts so it can be unit tested with a fabricated event.
 */

import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { checkArgv, checkCommand, defaultContext, type GuardrailContext, type GuardrailHit } from "./rules";

export type GuardrailDecision = { block: true; reason: string } | undefined;

export interface PolicyOptions {
	enabled: boolean;
	/** Overrides the ambient home/cwd, mainly for tests. */
	context?: GuardrailContext;
}

/** Decide whether a bash command or literal exec argv call should be blocked. */
export function evaluateBashCall(event: ToolCallEvent, options: PolicyOptions): GuardrailDecision {
	if (!options.enabled) return undefined;

	const base = options.context ?? defaultContext();
	// Both tools can run in a different directory than the agent process, and
	// relative targets are judged from that per-call directory.
	const cwd = (event.input as { cwd?: unknown }).cwd;
	const context = typeof cwd === "string" && cwd ? { ...base, cwd } : base;
	let hit: GuardrailHit | null;
	if (isToolCallEventType("bash", event)) {
		const command = event.input.command;
		if (typeof command !== "string") return undefined;
		hit = checkCommand(command, context);
	} else if (event.toolName === "exec") {
		const argv = (event.input as { argv?: unknown }).argv;
		if (!Array.isArray(argv) || !argv.every((arg): arg is string => typeof arg === "string")) return undefined;
		hit = checkArgv(argv, context);
	} else {
		return undefined;
	}
	if (!hit) return undefined;

	return {
		block: true,
		reason: [
			`Guardrail blocked this command: ${hit.reason}.`,
			`Offending fragment: ${hit.match}`,
			"If this really is intended, ask the user to run it themselves or to disable the guardrail with /guardrail off.",
		].join("\n"),
	};
}
