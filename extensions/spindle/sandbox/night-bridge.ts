/**
 * Cross-extension bridge: the sandbox policy a night run asks for.
 *
 * Subagents are separate `pi` processes, so an event on the parent's bus never
 * reaches them. They pick the policy up from the night-mode handshake file
 * instead, the same way they already inherit the report path and the hard rules
 * (see `agents/pi-args.ts`, which reads the same file).
 *
 * The dependency direction is deliberate and one-way: spindle reads night-mode,
 * never the reverse, so night-mode stays usable without spindle.
 */

import { isNightRunParticipant, readActiveNightRun } from "../../night-mode/night-run.ts";
import { isSandboxMode } from "./policy.ts";
import type { SandboxRequest } from "./protocol.ts";

/** Identity of the session asking, used to tell participants from bystanders. */
export interface NightSessionRef {
	sessionId?: string | undefined;
	cwd?: string | undefined;
}

/**
 * The active night run's requested policy, if any. Returns undefined when no run
 * is in flight, the run did not ask for a sandbox, or **this process is not part
 * of the run** — a handshake file is global, and a session the user opens while a
 * run is in flight keeps whatever `spindle.json` configures.
 */
export function activeNightSandboxRequest(ref: NightSessionRef = {}): SandboxRequest | undefined {
	const run = readActiveNightRun();
	const requested = run?.sandbox;
	if (!run || !requested || !isSandboxMode(requested.mode)) return undefined;
	if (!isNightRunParticipant(run, ref)) return undefined;
	const roots = Array.isArray(requested.allowWrite)
		? requested.allowWrite.filter((entry): entry is string => typeof entry === "string" && !!entry.trim())
		: [];
	const domains = Array.isArray(requested.network?.allowedDomains)
		? requested.network.allowedDomains.filter((entry): entry is string => typeof entry === "string" && !!entry.trim())
		: [];
	return {
		mode: requested.mode,
		...(roots.length ? { allowWrite: roots } : {}),
		...(domains.length || requested.network?.allowLoopback === true
			? {
					network: {
						...(domains.length ? { allowedDomains: domains } : {}),
						...(requested.network?.allowLoopback === true ? { allowLoopback: true } : {}),
					},
				}
			: {}),
	};
}
