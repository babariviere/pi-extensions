/**
 * The sandbox floor the parent imposed on this subagent process.
 *
 * A subagent is its own `pi` process, so it resolves its own `spindle.json` and
 * would otherwise run under whatever the ambient config says. The agent's
 * `sandbox:` frontmatter travels on the `--{@link SANDBOX_MODE_FLAG}` CLI flag
 * (a flag, not an env var, because `herdr agent start` passes native args after
 * `--` but cannot inject environment variables) and is read here.
 *
 * It is a floor, not a setting: `sandbox/resolve.ts` can only tighten it, so a
 * research agent told to run `read-only` cannot talk itself back into write
 * access with `/sandbox`.
 */

import { SANDBOX_MODE_FLAG } from "../agents/constants.ts";
import { readFlagArgument } from "../core/argv-flag.ts";
import { isSandboxMode } from "./policy.ts";
import type { SandboxRequest } from "./protocol.ts";

/**
 * The floor this process was launched with, or undefined for a normal session
 * (no flag) and for an unrecognised mode, which is ignored rather than fatal:
 * a typo in an agent file must not make the child unlaunchable.
 */
export function agentSandboxFloor(argv?: readonly string[]): SandboxRequest | undefined {
	const raw = readFlagArgument(SANDBOX_MODE_FLAG, argv)?.trim();
	if (!raw || !isSandboxMode(raw)) return undefined;
	return { mode: raw };
}
