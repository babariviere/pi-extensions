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

import { buildNightContract, readActiveNightRun } from "../../night-mode/night-run.ts";
import { ALLOWED_TOOLS_FLAG, SANDBOX_MODE_FLAG, SPINDLE_EXEC_TOOL } from "./constants.ts";
import { type DiscoveredAgent } from "./discovery.ts";
import { injectOutputInstruction } from "./paths.ts";

/**
 * Absolute path to the child-side extension, next to this file. It only
 * registers the parent-set flags, so the parent loads it only when restricting
 * the agent's tools or its sandbox (see buildChildArgs).
 */
export function childExtensionPath(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "child-extension.ts");
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
	/** Files the child should read first for context; injected into the task. */
	reads?: string[];
	/** Inherit the night-mode contract (unattended run, no outbound messages, draft PRs). */
	night?: boolean;
	/**
	 * The child's own working copy, when the host gave it one. Changes what the
	 * night contract tells it about where to work.
	 */
	workspacePath?: string;
	/**
	 * Durable directory for the child's deliverables, when the host gave it one.
	 * Named in the task message, because the working copy above is deleted when
	 * the run ends.
	 */
	artifactsDir?: string;
}

/** Prepend a read-first instruction listing the context files, if any. */
function withReads(task: string, reads: string[] | undefined): string {
	if (!reads || reads.length === 0) return task;
	const list = reads.map((f) => `\`${f}\``).join(", ");
	return `Read these files first for context: ${list}.\n\n${task}`;
}

/**
 * Prepend the night-mode contract when the run opts into it and a night run is
 * actually in flight. Reading the handshake here (rather than passing the text
 * down) keeps the caller from having to know about night mode.
 */
function withNight(task: string, night: boolean | undefined, workspacePath?: string): string {
	if (!night) return task;
	const run = readActiveNightRun();
	return run ? `${buildNightContract(run, workspacePath)}\n${task}` : task;
}

/** What the task framing needs beyond the task itself. */
export interface TaskFraming {
	reads?: string[];
	night?: boolean;
	workspacePath?: string;
	artifactsDir?: string;
}

/** The task framing given to the child agent, with the final-message rider. */
export function formatTaskMessage(task: string, framing: TaskFraming = {}): string {
	const body = injectOutputInstruction(withReads(task, framing.reads), {
		...(framing.artifactsDir ? { artifactsDir: framing.artifactsDir } : {}),
	});
	return withNight(`Task: ${body}`, framing.night, framing.workspacePath);
}

/**
 * Produce the ordered `pi` args (excluding the `pi` binary itself). The final
 * element is the `Task: ...` prompt carrying the final-message instruction.
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
	const thinking =
		opts.thinkingOverride ?? (qualified ? extractThinkingSuffix(qualified) : undefined) ?? agent.config.thinking;
	if (model) args.push("--model", model);
	if (thinking && thinking !== "off") args.push("--thinking", thinking);

	// When the agent declares a tool allowlist, keep `spindle_exec` in pi's
	// `--tools` filter regardless: it is the child's ONLY tool path when it runs
	// Spindle in full code mode (Spindle strips the pi core tools from the active
	// set), so an allowlist that omits it leaves the agent unable to do anything.
	// The declared allowlist is still enforced one level down: it travels via
	// `--${ALLOWED_TOOLS_FLAG}` and the child's Spindle removes the disallowed
	// tools from the `pi.*` / `extensions.*` schema inside the sandbox. The child
	// extension is loaded here only to register that flag; a child with no
	// allowlist needs no injected extension at all. With no allowlist all tools
	// are enabled, so nothing to add.
	const restrictsTools = !!agent.config.tools && agent.config.tools.length > 0;
	// The sandbox mode travels the same way, and is a floor the child cannot
	// loosen (see `sandbox/agent-floor.ts`). It is the preferred way to bound a
	// research agent: it keeps `bash` available for reads instead of removing the
	// tool and letting the agent discover the restriction by failing.
	const sandboxMode = agent.config.sandbox;
	if (restrictsTools || sandboxMode) {
		args.push("--extension", childExtensionPath());
	}
	if (restrictsTools) {
		const declared = agent.config.tools ?? [];
		const tools = declared.includes(SPINDLE_EXEC_TOOL) ? [...declared] : [...declared, SPINDLE_EXEC_TOOL];
		args.push("--tools", tools.join(","));
		args.push(`--${ALLOWED_TOOLS_FLAG}`, declared.join(","));
	}
	if (sandboxMode) {
		args.push(`--${SANDBOX_MODE_FLAG}`, sandboxMode);
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

	// Deliver the task inline as the initial message (headless spawn: any chars
	// are safe). The herdr backend omits it here and submits it via `agent prompt`
	// instead, since `agent start` cannot encode multi-line shell args.
	if (opts.includeTask !== false) {
		args.push(
			formatTaskMessage(task, {
				...(opts.reads ? { reads: opts.reads } : {}),
				...(opts.night ? { night: opts.night } : {}),
				...(opts.workspacePath ? { workspacePath: opts.workspacePath } : {}),
				...(opts.artifactsDir ? { artifactsDir: opts.artifactsDir } : {}),
			}),
		);
	}

	return args;
}
