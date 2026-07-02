/**
 * Constants shared between the parent extension (which builds the child `pi`
 * invocation) and the child-side result tool. Kept in a tiny leaf module so the
 * result-tool extension can import them without pulling in backend code.
 */

/** Env var carrying the authoritative output path into the child pi process. */
export const OUTPUT_PATH_ENV = "PI_SUBAGENT_OUTPUT_PATH";

/** Name of the tool the child agent calls to hand its result back. */
export const SUBMIT_RESULT_TOOL = "submit_result";
