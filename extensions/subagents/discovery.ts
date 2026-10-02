/** Native kernel definition. Instance names no longer discover Markdown personas. */
import type { SandboxMode } from "../sandbox/policy.ts";

export interface DiscoveredAgent {
	config: {
		name: string;
		description?: string;
		model?: string;
		thinking?: string;
		systemPromptMode?: "replace" | "append";
		inheritProjectContext?: boolean;
		inheritSkills?: boolean;
		sandbox?: SandboxMode;
	};
	systemPrompt: string;
	sourcePath: string;
	scope: "builtin";
}
export function builtinAgent(): DiscoveredAgent {
	return {
		config: { name: "task", description: "Generic native subagent" },
		systemPrompt: "",
		sourcePath: "<builtin>",
		scope: "builtin",
	};
}
