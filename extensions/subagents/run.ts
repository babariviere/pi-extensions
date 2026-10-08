/** Host-only inputs for a persistent native worker. */
import type { DiscoveredAgent } from "./discovery.ts";
import type { ActiveNightRun } from "../night-mode/night-run.ts";

export interface RunRequest {
	agent: DiscoveredAgent;
	task: string;
	index: number;
	/** Model and thinking are pinned by host policy, never tool arguments. */
	overrides?: { model?: string; thinking?: string };
	night?: boolean;
	/** Private night workspace and surviving deliverables, allocated by the host. */
	cwd?: string;
	artifactsDir?: string;
}
export interface RunContext {
	sessionId: string | undefined;
	sessionFile: string | undefined;
	runId: string;
	cwd: string;
	timeoutMs: number;
	deadlineAt?: number;
	nightRun?: ActiveNightRun;
	projectTrusted?: boolean;
	signal?: AbortSignal;
}
export function runCwd(request: RunRequest, context: RunContext): string {
	return request.cwd ?? context.cwd;
}
export function withChildConfigHome(configHome: string | undefined, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return configHome ? { ...base, XDG_CONFIG_HOME: configHome } : base;
}
