/**
 * Build the child `pi` CLI invocation from a discovered agent config.
 *
 * `pi` has no native `--agent <name>` flag, so we reconstruct the invocation
 * from the agent's frontmatter (model/thinking, tools, system prompt, skills)
 * the same way pi-subagents does. Keeping this in one module means switching to
 * a native flag later (if one appears) is a one-file change.
 *
 * System-prompt handling: we honor the agent's `systemPromptMode` -
 * `--system-prompt` (replace) or `--append-system-prompt` (append). Replace is
 * safe once the child runs on the intended provider: the earlier 400s came from
 * bare thinking-suffixed models resolving to Bedrock (see provider qualification
 * below), not from replacing the prompt. Inherited context/skills are controlled
 * with native flags (`--no-skills`, `--no-context-files`).
 *
 * Model provider: agent frontmatter often uses a bare model name. We qualify it
 * with the caller-resolved default provider (e.g. `anthropic/claude-opus-4-8`)
 * BEFORE the thinking suffix, because pi resolves a bare, thinking-suffixed name
 * to the wrong provider (Bedrock). See `settings.ts` and `qualifyModel`.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { OUTPUT_PATH_FLAG, SUBMIT_RESULT_TOOL } from "./constants.ts";
import { type DiscoveredAgent } from "./discovery.ts";
import { injectOutputInstruction } from "./paths.ts";

/** Absolute path to the child-side result-tool extension, next to this file. */
export function resultToolPath(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "result-tool.ts");
}

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

/** Strip a trailing `:thinking` suffix from a model id, if one is present. */
export function stripThinkingSuffix(model: string): string {
	const colonIdx = model.lastIndexOf(":");
	if (colonIdx !== -1 && THINKING_LEVELS.includes(model.substring(colonIdx + 1))) {
		return model.substring(0, colonIdx);
	}
	return model;
}

/** Extract a trailing `:thinking` suffix from a model id, if one is present. */
export function extractThinkingSuffix(model: string): string | undefined {
	const colonIdx = model.lastIndexOf(":");
	if (colonIdx !== -1 && THINKING_LEVELS.includes(model.substring(colonIdx + 1))) {
		return model.substring(colonIdx + 1);
	}
	return undefined;
}

/**
 * Qualify a bare model name with the default provider so pi routes it to the
 * intended provider. Already-qualified (`provider/model`), empty, or
 * provider-less-config models are returned unchanged.
 */
export function qualifyModel(model: string | undefined, defaultProvider: string | undefined): string | undefined {
	if (!model) return model;
	if (model.includes("/")) return model;
	if (!defaultProvider) return model;
	return `${defaultProvider}/${model}`;
}

export interface ChildInvocationOpts {
	sessionFile: string;
	/** Path the child's `submit_result` tool writes to, passed via a CLI flag. */
	outputPath: string;
	/** Path the system-prompt body was written to (caller writes it before spawn). */
	systemPromptFile?: string;
	/** Provider used to qualify a bare agent model (resolved from settings). */
	defaultProvider?: string;
	/** Per-run model override; takes precedence over the agent's frontmatter model. */
	modelOverride?: string;
	/** Per-run thinking override; takes precedence over the agent's frontmatter thinking. */
	thinkingOverride?: string;
	/**
	 * When false, omit the inline task message; the caller submits the task
	 * separately (e.g. via `herdr agent prompt`, which delivers it as a clean
	 * user message rather than a shell arg). Defaults to true (headless spawn).
	 */
	includeTask?: boolean;
}

/** The task framing given to the child agent, with the result-submission rider. */
export function formatTaskMessage(task: string): string {
	return `Task: ${injectOutputInstruction(task)}`;
}

/**
 * Produce the ordered `pi` args (excluding the `pi` binary itself). The final
 * element is the `Task: ...` prompt carrying the injected output instruction.
 */
export function buildChildArgs(agent: DiscoveredAgent, task: string, opts: ChildInvocationOpts): string[] {
	const args: string[] = ["--session", opts.sessionFile];

	// Resolve the model and thinking level independently. Thinking travels via
	// pi's dedicated `--thinking` flag rather than a model suffix, so an agent
	// that declares only `thinking` (no `model`) still gets its level applied
	// instead of silently falling back to the child's default thinking.
	const baseModel = opts.modelOverride ?? agent.config.model;
	const qualified = qualifyModel(baseModel, opts.defaultProvider);
	const model = qualified ? stripThinkingSuffix(qualified) : undefined;
	// Thinking precedence: explicit override, then a suffix embedded in the chosen
	// model, then the agent's frontmatter thinking.
	const thinking = opts.thinkingOverride ?? (qualified ? extractThinkingSuffix(qualified) : undefined) ?? agent.config.thinking;
	if (model) args.push("--model", model);
	if (thinking && thinking !== "off") args.push("--thinking", thinking);

	// When the agent declares a tool allowlist, append the result tool so pi's
	// `--tools` filter (which also gates custom/extension tools) doesn't drop it.
	// With no allowlist all tools are enabled, so nothing to add.
	if (agent.config.tools && agent.config.tools.length > 0) {
		const tools = agent.config.tools.includes(SUBMIT_RESULT_TOOL)
			? agent.config.tools
			: [...agent.config.tools, SUBMIT_RESULT_TOOL];
		args.push("--tools", tools.join(","));
	}

	// Load the child-side result tool so the agent can hand its output back
	// without needing write/bash access or knowing the output path. The path
	// travels via a CLI flag the tool reads; the agent never sees it.
	args.push("--extension", resultToolPath());
	args.push(`--${OUTPUT_PATH_FLAG}`, opts.outputPath);

	if (opts.systemPromptFile && agent.systemPrompt.trim().length > 0) {
		const flag = agent.config.systemPromptMode === "append" ? "--append-system-prompt" : "--system-prompt";
		args.push(flag, opts.systemPromptFile);
	}

	if (agent.config.inheritSkills === false) {
		args.push("--no-skills");
	}

	if (agent.config.inheritProjectContext === false) {
		args.push("--no-context-files");
	}

	// Deliver the task inline as the initial message (headless spawn: any chars
	// are safe). The herdr backend omits it here and submits it via `agent prompt`
	// instead, since `agent start` cannot encode multi-line shell args.
	if (opts.includeTask !== false) {
		args.push(formatTaskMessage(task));
	}

	return args;
}
