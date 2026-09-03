/**
 * Guardrail policy: the pure decision function behind the `tool_call` hook,
 * kept out of index.ts so it can be unit tested with a fabricated event.
 */

import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { checkCommand, defaultContext, type GuardrailContext } from "./rules";

export type GuardrailDecision = { block: true; reason: string } | undefined;

export interface PolicyOptions {
	enabled: boolean;
	/** Overrides the ambient home/cwd, mainly for tests. */
	context?: GuardrailContext;
}

/**
 * Decide whether a tool call should be blocked. Only `bash` is inspected;
 * everything else passes through untouched.
 */
export function evaluateBashCall(event: ToolCallEvent, options: PolicyOptions): GuardrailDecision {
	if (!options.enabled) return undefined;
	if (!isToolCallEventType("bash", event)) return undefined;

	const command = event.input.command;
	if (typeof command !== "string") return undefined;

	const base = options.context ?? defaultContext();
	// The bash tool can run in a different directory than the agent process
	// (spindle passes a per-call cwd), and relative targets are judged from it.
	const cwd = (event.input as { cwd?: unknown }).cwd;
	const context = typeof cwd === "string" && cwd ? { ...base, cwd } : base;

	const hit = checkCommand(command, context);
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
