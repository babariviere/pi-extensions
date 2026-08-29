/**
 * Which policy actually applies, given three inputs that can disagree:
 *
 *  - `spindle.json`, the session's baseline,
 *  - a request from `/sandbox` or another extension,
 *  - the floor an active night run imposes.
 *
 * The night floor is not advisory. An unattended run is sandboxed for its whole
 * duration, so a request can only ever *tighten* it: `/sandbox off` during a
 * night run is refused, and the night's own writable roots (its working copy, the
 * report, the ledger) always stay in the set, so a tightening request cannot
 * accidentally break the run it is protecting.
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
	allowedDomains: string[];
	deniedDomains: string[];
}

export interface EffectiveSandboxInput {
	settings: SandboxSettings;
	/** Last request from `/sandbox` or the event bus, if any. */
	requested?: SandboxRequest | undefined;
	/** Policy an active night run demands. Acts as a floor, never as a ceiling. */
	night?: SandboxRequest | undefined;
}

export interface EffectiveSandbox {
	mode: SandboxMode;
	allowWrite: string[];
	denyWrite: string[];
	denyRead: string[];
	network: { allowedDomains: string[]; deniedDomains: string[] };
	/** Where the mode came from. */
	source: "config" | "request" | "night";
	/**
	 * Set when a request asked for something looser than the night floor. The
	 * caller reports this, so a refused `/sandbox off` says so instead of silently
	 * appearing to work.
	 */
	refused?: { asked: SandboxMode; enforced: SandboxMode };
}

const dedupe = (values: string[]): string[] => [...new Set(values.map((value) => value.trim()).filter(Boolean))];

export function effectiveSandbox(input: EffectiveSandboxInput): EffectiveSandbox {
	const { settings, requested, night } = input;
	const asked = requested?.mode ?? settings.mode;
	const mode = night ? tighterMode(asked, night.mode) : asked;

	const source = night && mode === night.mode && mode !== asked ? "night" : requested ? "request" : "config";

	return {
		mode,
		// The night's roots are always present: a tightening request must not cut
		// the run's own report or ledger out of the writable set.
		allowWrite: dedupe([...settings.allowWrite, ...(night?.allowWrite ?? []), ...(requested?.allowWrite ?? [])]),
		denyWrite: [...settings.denyWrite],
		denyRead: [...settings.denyRead],
		network: {
			allowedDomains: [...settings.allowedDomains],
			deniedDomains: [...settings.deniedDomains],
		},
		source,
		...(mode !== asked ? { refused: { asked, enforced: mode } } : {}),
	};
}
