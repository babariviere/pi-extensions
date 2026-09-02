/**
 * Constants shared between the parent extension (which builds the child `pi`
 * invocation) and the child-side extension it injects. Kept in a tiny leaf
 * module so the child extension can import them without pulling in backend code.
 */

/** Spindle's sandbox tool; the child's only tool path in full code mode. */
export const SPINDLE_EXEC_TOOL = "spindle_exec";

/**
 * CLI flag carrying the sandbox mode the agent's `sandbox:` frontmatter asks
 * for into the child. The child's Spindle applies it as a *floor*: `/sandbox`
 * inside a subagent can tighten it but never loosen it, the same way an active
 * night run holds the sandbox for its whole duration.
 *
 * This is how a subagent is bounded. Removing tools from the child instead
 * (the former `tools:` allowlist) took the capability away without taking the
 * danger away: the agent found out by failing mid-task and rerouted through
 * weaker tools. The sandbox keeps every tool and lets the kernel refuse the
 * writes.
 *
 * A flag (registered by the child extension via `pi.registerFlag`) rather than
 * an env var so the child can be launched by `herdr agent start`, which passes
 * native args after `--` but cannot inject environment variables.
 */
export const SANDBOX_MODE_FLAG = "spindle-sandbox";
