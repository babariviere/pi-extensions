/**
 * Event contract for changing the sandbox mode mid-session.
 *
 * The mode cannot be decided once at startup: an unattended run wants
 * enforcement that an interactive session would find obstructive, and it starts
 * long after the session did. So another extension (night-mode) asks for a
 * policy over pi's event bus, and Spindle answers with the resulting state.
 *
 * This is extension-level trust, not model-level: `pi.events` is not reachable
 * from inside `spindle_exec`, so the agent cannot request its own sandbox.
 */

import { isSandboxMode, type SandboxMode } from "./policy.ts";

export const SANDBOX_REQUEST_EVENT = "spindle:sandbox-request";
export const SANDBOX_STATE_EVENT = "spindle:sandbox-state";

export interface SandboxRequest {
	mode: SandboxMode;
	/** Extra writable roots. `~` is expanded; relative paths resolve against cwd. */
	allowWrite?: string[];
	/**
	 * Domains to add to the session's allowlist. Only honoured from a night run
	 * (see `resolve.ts`), which is the one case where widening beats failing
	 * unattended.
	 */
	network?: { allowedDomains?: string[]; allowLoopback?: boolean };
}

/**
 * A request to change the sandbox. `policy: null` (or absent) reverts to what
 * `spindle.json` configures, which is how a night run releases enforcement when
 * it ends.
 */
export interface SandboxRequestEvent {
	policy: SandboxRequest | null;
	/** Shown in the notification, so the user knows what changed the mode. */
	reason?: string;
}

/** Published after every applied request, and once at session start. */
export interface SandboxStateEvent {
	mode: SandboxMode;
	/** True when the policy restricts anything. */
	enforcing: boolean;
	/** True when `bash` is bounded by the kernel rather than only by path checks. */
	osEnforced: boolean;
	writableRoots: number;
	/** Where the active policy came from. */
	source: "config" | "request";
	degradedReason?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Validate an untrusted bus payload into a request. */
export function parseSandboxRequestEvent(value: unknown): SandboxRequestEvent | undefined {
	if (!isRecord(value)) return undefined;
	const reason = typeof value.reason === "string" ? value.reason : undefined;
	if (value.policy === null || value.policy === undefined) {
		return { policy: null, ...(reason ? { reason } : {}) };
	}
	if (!isRecord(value.policy)) return undefined;
	const { mode, allowWrite, network } = value.policy;
	if (!isSandboxMode(mode)) return undefined;
	const roots = Array.isArray(allowWrite)
		? allowWrite.filter((entry): entry is string => typeof entry === "string" && !!entry.trim())
		: undefined;
	const domains =
		isRecord(network) && Array.isArray(network.allowedDomains)
			? network.allowedDomains.filter((entry): entry is string => typeof entry === "string" && !!entry.trim())
			: undefined;
	const loopback = isRecord(network) && network.allowLoopback === true;
	return {
		policy: {
			mode,
			...(roots?.length ? { allowWrite: roots } : {}),
			...(domains?.length || loopback
				? {
						network: {
							...(domains?.length ? { allowedDomains: domains } : {}),
							...(loopback ? { allowLoopback: true } : {}),
						},
					}
				: {}),
		},
		...(reason ? { reason } : {}),
	};
}
