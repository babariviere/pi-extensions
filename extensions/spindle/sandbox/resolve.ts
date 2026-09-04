/**
 * Which policy actually applies, given three inputs that can disagree:
 *
 *  - `spindle.json`, the session's baseline,
 *  - a request from `/sandbox` or another extension,
 *  - the floor an active night run imposes,
 *  - the floor the parent imposed on a subagent (its `sandbox:` frontmatter).
 *
 * The night floor is not advisory. An unattended run is sandboxed for its whole
 * duration, so a request can only ever *tighten* it: `/sandbox off` during a
 * night run is refused, and the night's own writable roots (its working copy, the
 * report, the ledger) always stay in the set, so a tightening request cannot
 * accidentally break the run it is protecting.
 *
 * There is no egress exception any more: the Seatbelt profile always emits
 * `(allow network*)` (see `seatbelt-profile.ts`), so there is no allowlist for
 * a night run to widen and no per-domain floor to compute. The night floor is
 * therefore purely a tightening floor on the mode, plus a writable-root union.
 *
 * Pure, so the precedence rules are testable without a session.
 */

import { type SandboxMode, tighterMode } from "./policy.ts";
import type { SandboxRequest } from "./protocol.ts";

/** The `sandbox` block of `spindle.json`. */
export interface SandboxSettings {
	mode: SandboxMode;
	allowWrite: string[];
	denyWrite: string[];
	denyRead: string[];
}

export interface EffectiveSandboxInput {
	settings: SandboxSettings;
	/** Last request from `/sandbox` or the event bus, if any. */
	requested?: SandboxRequest | undefined;
	/** Policy an active night run demands. Acts as a floor, never as a ceiling. */
	night?: SandboxRequest | undefined;
	/**
	 * Policy the parent imposed on this subagent process (the agent's `sandbox:`
	 * frontmatter, read from argv). Also a floor: an agent bounded to
	 * `read-only` cannot `/sandbox workspace-write` its way out.
	 */
	agent?: SandboxRequest | undefined;
}

export interface EffectiveSandbox {
	mode: SandboxMode;
	allowWrite: string[];
	denyWrite: string[];
	denyRead: string[];
	/** Where the mode came from. */
	source: "config" | "request" | "night" | "agent";
	/**
	 * Set when a request asked for something looser than the night floor. The
	 * caller reports this, so a refused `/sandbox off` says so instead of silently
	 * appearing to work.
	 */
	refused?: { asked: SandboxMode; enforced: SandboxMode };
}

const dedupe = (values: string[]): string[] => [...new Set(values.map((value) => value.trim()).filter(Boolean))];

export function effectiveSandbox(input: EffectiveSandboxInput): EffectiveSandbox {
	const { settings, requested, night, agent } = input;
	const asked = requested?.mode ?? settings.mode;
	// Both floors tighten, never loosen; the tightest of the three wins.
	let mode = asked;
	if (night) mode = tighterMode(mode, night.mode);
	if (agent) mode = tighterMode(mode, agent.mode);

	const source =
		night && mode === night.mode && mode !== asked
			? "night"
			: agent && mode === agent.mode && mode !== asked
				? "agent"
				: requested
					? "request"
					: "config";

	return {
		mode,
		// The night's roots are always present: a tightening request must not cut
		// the run's own report or ledger out of the writable set.
		allowWrite: dedupe([
			...settings.allowWrite,
			...(night?.allowWrite ?? []),
			...(agent?.allowWrite ?? []),
			...(requested?.allowWrite ?? []),
		]),
		denyWrite: [...settings.denyWrite],
		denyRead: [...settings.denyRead],
		source,
		...(mode !== asked ? { refused: { asked, enforced: mode } } : {}),
	};
}
