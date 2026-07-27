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
