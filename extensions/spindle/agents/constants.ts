/**
 * Constants shared between the parent extension (which builds the child `pi`
 * invocation) and the child-side extension it injects. Kept in a tiny leaf
 * module so the child extension can import them without pulling in backend code.
 */

/** Spindle's sandbox tool; the child's only tool path in full code mode. */
export const SPINDLE_EXEC_TOOL = "spindle_exec";

/**
 * CLI flag carrying the agent's declared `tools:` allowlist into the child.
 * pi's own `--tools` filter cannot express the restriction any more: the child
 * must keep `spindle_exec` (its only tool path under full code mode), so the
 * allowlist is enforced one level down instead, by removing the disallowed
 * tools from the `pi.*` / `extensions.*` schema inside the sandbox.
 *
 * A flag (registered by the child extension via `pi.registerFlag`) rather than
 * an env var so the child can be launched by `herdr agent start`, which passes
 * native args after `--` but cannot inject environment variables.
 */
export const ALLOWED_TOOLS_FLAG = "spindle-allowed-tools";

/**
 * CLI flag carrying the sandbox mode the agent's `sandbox:` frontmatter asks
 * for into the child. The child's Spindle applies it as a *floor*: `/sandbox`
 * inside a subagent can tighten it but never loosen it, the same way an active
 * night run holds the sandbox for its whole duration.
 *
 * This is the enforcement a research agent wants instead of having `bash`
 * removed from its tools: reads stay available, the kernel refuses the writes.
 */
export const SANDBOX_MODE_FLAG = "spindle-sandbox";
