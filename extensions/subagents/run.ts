/** Host-only inputs for a persistent native worker. */
import type { DiscoveredAgent } from "./discovery.ts";

export interface RunRequest {
	agent: DiscoveredAgent;
	task: string;
	index: number;
	/** Model and thinking are pinned by host policy, never tool arguments. */
	overrides?: { model?: string; thinking?: string };
	/** Legacy persisted marker. These workers must not resume without their sandbox policy. */
	night?: boolean;
}
export interface RunContext {
	sessionId: string | undefined;
	sessionFile: string | undefined;
	runId: string;
	cwd: string;
	timeoutMs: number;
	deadlineAt?: number;
	nightRun?: unknown;
	projectTrusted?: boolean;
	signal?: AbortSignal;
}
export function withChildConfigHome(configHome: string | undefined, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return configHome ? { ...base, XDG_CONFIG_HOME: configHome } : base;
}

export function isLegacyNightWorker(request: RunRequest, context: RunContext): boolean {
	return request.night === true || context.nightRun !== undefined;
}

export function assertSupportedWorker(request: RunRequest, context: RunContext): void {
	if (isLegacyNightWorker(request, context)) throw new Error("Night workers are retired; spawn a new named worker.");
}
