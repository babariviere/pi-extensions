/** Subagent host policy only. Pi owns codemode execution settings. */
export interface SubagentsConfig {
	maxPerExecution: number;
	timeoutMs: number;
	waitMs: number;
	defaultModel?: string;
	defaultThinking?: string;
	/** Experimental committed run lifecycle and reload-stable runner. Omitted means automatic headless/Herdr. */
	backend?: "durable";
}

export const MIN_AGENT_TIMEOUT_MS = 1_000;
export const MAX_AGENT_TIMEOUT_MS = 24 * 3_600_000;
export const DEFAULT_SUBAGENTS_CONFIG: SubagentsConfig = {
	maxPerExecution: 100,
	timeoutMs: 2 * 60 * 60_000,
	waitMs: 10 * 60_000,
};

const bounded = (value: unknown, fallback: number, min: number, max: number): number =>
	typeof value === "number" && Number.isInteger(value) ? Math.max(min, Math.min(max, value)) : fallback;
const nonempty = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim() ? value.trim() : undefined;
const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

export function normalizeSubagentsConfig(input: Record<string, unknown>): SubagentsConfig {
	const model = nonempty(input.defaultModel);
	const thinking =
		typeof input.defaultThinking === "string" && THINKING.has(input.defaultThinking)
			? input.defaultThinking
			: undefined;
	return {
		maxPerExecution: bounded(input.maxPerExecution, DEFAULT_SUBAGENTS_CONFIG.maxPerExecution, 1, 1_000),
		timeoutMs: bounded(
			input.timeoutMs,
			DEFAULT_SUBAGENTS_CONFIG.timeoutMs,
			MIN_AGENT_TIMEOUT_MS,
			MAX_AGENT_TIMEOUT_MS,
		),
		waitMs: bounded(input.waitMs, DEFAULT_SUBAGENTS_CONFIG.waitMs, MIN_AGENT_TIMEOUT_MS, MAX_AGENT_TIMEOUT_MS),
		...(model ? { defaultModel: model } : {}),
		...(thinking ? { defaultThinking: thinking } : {}),
		...(input.backend === "durable" ? { backend: "durable" as const } : {}),
	};
}
