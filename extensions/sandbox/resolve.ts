import { type SandboxMode, tighterMode } from "./policy.ts";
import type { SandboxRequest } from "./protocol.ts";

/** The `sandbox` block of `sandbox.json`. */
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
	source: "config" | "request" | "agent";
	/**
	 * Set when a request asked for something looser than the agent floor. The
	 * caller reports this, so a refused `/sandbox off` says so instead of silently
	 * appearing to work.
	 */
	refused?: { asked: SandboxMode; enforced: SandboxMode };
}

const dedupe = (values: string[]): string[] => [...new Set(values.map((value) => value.trim()).filter(Boolean))];

export function effectiveSandbox(input: EffectiveSandboxInput): EffectiveSandbox {
	const { settings, requested, agent } = input;
	const asked = requested?.mode ?? settings.mode;
	const mode = agent ? tighterMode(asked, agent.mode) : asked;
	const source = mode !== asked ? "agent" : requested ? "request" : "config";

	return {
		mode,
		allowWrite: dedupe([...settings.allowWrite, ...(agent?.allowWrite ?? []), ...(requested?.allowWrite ?? [])]),
		denyWrite: [...settings.denyWrite],
		denyRead: dedupe([...settings.denyRead, ...(agent?.denyRead ?? []), ...(requested?.denyRead ?? [])]),
		source,
		...(mode !== asked ? { refused: { asked, enforced: mode } } : {}),
	};
}
