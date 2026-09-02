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

/**
 * CLI flag carrying the path to the file holding this run's task message.
 *
 * A subagent launched into a live herdr pane cannot take its task as a shell
 * arg: `herdr agent start` types the launch command into a shell and rejects
 * multi-line args. Delivering it afterwards by typing into pi's TUI (`herdr
 * agent prompt`) raced pi's startup - input that arrives before the TUI binds
 * its handler is dropped rather than buffered, which left an idle agent with an
 * empty composer and a run that failed at its timeout with no output.
 *
 * So the parent writes the task to a file and passes its path here; the child's
 * Spindle reads it and delivers it as the initial user message from inside pi
 * (see `agents/task-delivery.ts`), where no startup race exists.
 *
 * Unlike {@link SANDBOX_MODE_FLAG} this flag is registered by Spindle itself,
 * not by the injected child extension: task delivery has nothing to do with
 * sandboxing, so it must work for an agent that declares no `sandbox:` and gets
 * no `--extension` at all.
 *
 * `@file` on pi's own command line was the alternative and is rejected: pi wraps
 * that content in `<file name="...">...</file>`, so the task would reach the
 * model framed as an attachment instead of as the instruction it is.
 */
export const TASK_FILE_FLAG = "spindle-task-file";
