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

import { readActiveNightRun } from "../../night-mode/night-run.ts";
import { isSandboxMode } from "./policy.ts";
import type { SandboxRequest } from "./protocol.ts";

/**
 * The active night run's requested policy, if any. Returns undefined when no run
 * is in flight or the run did not ask for a sandbox, so the caller falls back to
 * `spindle.json`.
 */
export function activeNightSandboxRequest(): SandboxRequest | undefined {
	const run = readActiveNightRun();
	const requested = run?.sandbox;
	if (!requested || !isSandboxMode(requested.mode)) return undefined;
	const roots = Array.isArray(requested.allowWrite)
		? requested.allowWrite.filter((entry): entry is string => typeof entry === "string" && !!entry.trim())
		: [];
	return { mode: requested.mode, ...(roots.length ? { allowWrite: roots } : {}) };
}
