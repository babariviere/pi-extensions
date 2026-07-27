/**
 * Constants shared between the parent extension (which builds the child `pi`
 * invocation) and the child-side result tool. Kept in a tiny leaf module so the
 * result-tool extension can import them without pulling in backend code.
 */

/**
 * CLI flag carrying the authoritative output path into the child pi process.
 * A flag (registered by the result-tool extension via `pi.registerFlag`) rather
 * than an env var so the child can be launched by `herdr agent start`, which
 * passes native args after `--` but cannot inject environment variables.
 */
export const OUTPUT_PATH_FLAG = "subagent-output-path";

/** Name of the tool the child agent calls to hand its result back. */
export const SUBMIT_RESULT_TOOL = "submit_result";

/** Spindle's sandbox tool; the child's only tool path in full code mode. */
export const SPINDLE_EXEC_TOOL = "spindle_exec";

/**
 * CLI flag carrying the agent's declared `tools:` allowlist into the child.
 * pi's own `--tools` filter cannot express the restriction any more: the child
 * must keep `spindle_exec` (its only tool path under full code mode), so the
 * allowlist is enforced one level down instead, by removing the disallowed
 * tools from the `pi.*` / `extensions.*` schema inside the sandbox.
 */
export const ALLOWED_TOOLS_FLAG = "spindle-allowed-tools";
