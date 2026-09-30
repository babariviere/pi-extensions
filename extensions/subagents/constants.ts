/** Compatibility names retained for parent-launched Pi child sessions. */
export const SANDBOX_MODE_FLAG = "code-mode-sandbox";
export const TASK_FILE_FLAG = "code-mode-task-file";

/** Children and background attempts must not recursively launch agents or jobs. */
export function isChildSession(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.PI_CODE_MODE_SUBAGENT === "1" || env.PI_BACKGROUND_AGENT_ATTEMPT === "1";
}
