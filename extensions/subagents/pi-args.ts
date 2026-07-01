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

import { type DiscoveredAgent } from "./discovery.ts";
import { injectOutputInstruction } from "./paths.ts";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

/** Append a `:thinking` suffix to a model id when appropriate. */
export function applyThinkingSuffix(model: string | undefined, thinking: string | undefined): string | undefined {
	if (!model || !thinking || thinking === "off") return model;
	const colonIdx = model.lastIndexOf(":");
	if (colonIdx !== -1 && THINKING_LEVELS.includes(model.substring(colonIdx + 1))) return model;
	return `${model}:${thinking}`;
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
	outputPath: string;
	/** Path the system-prompt body was written to (caller writes it before spawn). */
	systemPromptFile?: string;
	/** Provider used to qualify a bare agent model (resolved from settings). */
	defaultProvider?: string;
}

/**
 * Produce the ordered `pi` args (excluding the `pi` binary itself). The final
 * element is the `Task: ...` prompt carrying the injected output instruction.
 */
export function buildChildArgs(agent: DiscoveredAgent, task: string, opts: ChildInvocationOpts): string[] {
	const args: string[] = ["--session", opts.sessionFile];

	const model = applyThinkingSuffix(qualifyModel(agent.config.model, opts.defaultProvider), agent.config.thinking);
	if (model) args.push("--model", model);

	if (agent.config.tools && agent.config.tools.length > 0) {
		args.push("--tools", agent.config.tools.join(","));
	}

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

	const finalTask = injectOutputInstruction(task, opts.outputPath);
	args.push(`Task: ${finalTask}`);

	return args;
}
