/**
 * Pure request handling for the subagent tool: turn raw tool params plus the
 * discovered agents into a validated list of `RunRequest`s, or a caller-facing
 * error string. No I/O beyond reading settings for the model allowlist, and no
 * spawning, so this is unit-testable in isolation.
 */

import { type DiscoveredAgent } from "./discovery.ts";
import { indexOutputOverride } from "./paths.ts";
import { qualifyModel, stripThinkingSuffix, THINKING_LEVELS } from "./pi-args.ts";
import { type RunRequest } from "./run.ts";
import { readDefaultProvider, readEnabledModels } from "./settings.ts";

export interface NormalizedItem {
	agent: string;
	task: string;
	model?: string;
	thinking?: string;
	output?: string;
	reads?: string[];
}

export interface RawToolParams {
	agent?: string;
	task?: string;
	model?: string;
	thinking?: string;
	output?: string;
	reads?: string[];
	tasks?: NormalizedItem[];
}

/**
 * Resolve raw tool params to `RunRequest`s. Normalizes the single/parallel
 * shapes, validates per-run overrides, and binds each item to a discovered
 * agent. Returns `{ error }` with a caller-facing message on any failure.
 */
export function buildRunRequests(
	params: RawToolParams,
	agents: DiscoveredAgent[],
	cwd: string,
): { requests: RunRequest[] } | { error: string } {
	const normalized = normalizeRequests(params);
	if ("error" in normalized) return normalized;

	const overrideError = validateOverrides(normalized.items, cwd);
	if (overrideError) return { error: overrideError };

	const requests: RunRequest[] = [];
	for (let i = 0; i < normalized.items.length; i++) {
		const item = normalized.items[i];
		const agent = agents.find((a) => a.config.name === item.agent);
		if (!agent) return { error: unknownAgentError(item.agent, agents) };
		const overrides = item.model || item.thinking ? { model: item.model, thinking: item.thinking } : undefined;
		requests.push({
			agent,
			task: item.task,
			index: i,
			overrides,
			output: item.output ?? agent.config.output,
			reads: item.reads ?? agent.config.defaultReads,
		});
	}

	// Parallel runs that share one `output` override (passed on several tasks, or
	// inherited from one agent's frontmatter default) would otherwise all resolve
	// to the same file and clobber each other, leaving every run reading back the
	// last write. Give each output-bearing run a distinct `-<index>` suffix so the
	// files stay separate. Single runs keep their override verbatim, preserving
	// stable destinations like `.pi/goal/plan.md`.
	if (requests.length > 1) {
		for (const r of requests) {
			if (r.output) r.output = indexOutputOverride(r.output, r.index);
		}
	}

	return { requests };
}

export function normalizeRequests(params: RawToolParams): { items: NormalizedItem[] } | { error: string } {
	const hasSingle = !!params.agent || !!params.task;
	const hasParallel = Array.isArray(params.tasks) && params.tasks.length > 0;

	if (hasSingle && hasParallel) {
		return { error: "Provide either { agent, task } or { tasks: [...] }, not both." };
	}
	if (hasParallel) {
		return { items: params.tasks! };
	}
	if (hasSingle) {
		if (!params.agent || !params.task) {
			return { error: "A single run needs both `agent` and `task`." };
		}
		return {
			items: [{
				agent: params.agent,
				task: params.task,
				model: params.model,
				thinking: params.thinking,
				output: params.output,
				reads: params.reads,
			}],
		};
	}
	return { error: "Nothing to do. Use { action: \"list\" }, { agent, task }, or { tasks: [...] }." };
}

/** True when `model` (ignoring any thinking suffix / provider prefix) is in the allowlist. */
function isModelEnabled(model: string, enabled: string[], provider: string | undefined): boolean {
	const bare = stripThinkingSuffix(model);
	const candidates = new Set([model, bare, qualifyModel(bare, provider)].filter((v): v is string => !!v));
	return enabled.some((e) => candidates.has(e) || candidates.has(stripThinkingSuffix(e)));
}

/**
 * Validate per-run overrides before spawning. `thinking` must be a known level.
 * A `model` override is checked against the user's `enabledModels` allowlist so
 * a run cannot silently use an unavailable or pricey model. When no allowlist is
 * configured (empty), model overrides are unrestricted.
 */
export function validateOverrides(items: NormalizedItem[], cwd: string): string | undefined {
	const enabled = readEnabledModels(cwd);
	const provider = readDefaultProvider(cwd);
	for (const item of items) {
		if (item.thinking && !THINKING_LEVELS.includes(item.thinking)) {
			return `Invalid thinking level '${item.thinking}' for agent '${item.agent}'. Allowed: ${THINKING_LEVELS.join(", ")}.`;
		}
		if (item.model && enabled.length > 0 && !isModelEnabled(item.model, enabled, provider)) {
			return (
				`Model override '${item.model}' for agent '${item.agent}' is not in enabledModels. ` +
				`Allowed: ${enabled.join(", ")}.`
			);
		}
	}
	return undefined;
}

export function unknownAgentError(name: string, agents: DiscoveredAgent[]): string {
	const names = agents.map((a) => a.config.name).join(", ") || "(none)";
	return `Unknown agent '${name}'. Available: ${names}.`;
}
