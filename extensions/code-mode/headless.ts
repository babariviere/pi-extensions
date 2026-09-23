/** Explicit entry point for controller-owned background attempts, never auto-discovered. */
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { backgroundRole } from "./background-policy.ts";
import { CapturedToolCatalog } from "./capture/catalog.ts";
import { createCodeModeExecTool } from "./code-mode-tool.ts";
import { CodeModeState } from "./code-mode-state.ts";
import { CodeModeToolLifecycle, ownsCodeModeToolSource } from "./core/tool-ownership.ts";
import { isOpenAiCodexProvider } from "./edit-profile.ts";
import { defaultCodePreviewSettings } from "./ui/code-preview.ts";

export default function headlessCodeMode(pi: ExtensionAPI): void {
	const role = backgroundRole();
	if (!role) throw new Error("Headless Code Mode can only run in a background attempt");
	if (!process.env.PI_CODING_AGENT_DIR) throw new Error("Headless Code Mode requires an isolated Pi profile");
	const state = new CodeModeState(pi, new CapturedToolCatalog(), { headless: true });
	// A print-mode attempt does not need shell decoration, widgets, syntax highlighting,
	// commands, captured sibling tools, project skills, or a subagent runner.
	const tool = createCodeModeExecTool(state, defaultCodePreviewSettings(), (definition) => definition, {
		headless: true,
	});
	const ownership = new CodeModeToolLifecycle(() =>
		ownsCodeModeToolSource(pi.getAllTools(), fileURLToPath(import.meta.url)),
	);
	pi.registerTool(tool);
	pi.on("session_start", async (_event, context) => {
		if (context.hasUI) throw new Error("Headless Code Mode requires print mode");
		if (context.isProjectTrusted()) throw new Error("Headless Code Mode must not trust repository-local settings");
		await state.initialize(context);
		if (
			!state.config.fullCodeMode ||
			!state.config.mcp.readOnly ||
			(role !== "worker" && state.config.sandbox.mode !== "read-only")
		) {
			throw new Error("Headless Code Mode requires a staged, role-safe profile");
		}
		pi.setActiveTools(["code_mode"]);
	});
	pi.on("before_agent_start", (_event, context) => {
		const edit =
			role === "worker"
				? isOpenAiCodexProvider(context.model)
					? "For file changes use pi.applyPatch({ patch: π.patch }); put the V4A patch in payloads."
					: "Use pi.applyPatch for coordinated changes; pi.edit and pi.write are also available."
				: "Read the repository with pi.read, pi.grep, pi.find, and pi.ls; do not modify files.";
		return {
			systemPrompt: `${_event.systemPrompt}\n\nUse code_mode for permitted pi.* tools and configured read-only mcp.* calls. Do not use agents.*, web.*, or shell editing. ${edit}`,
		};
	});
	pi.on("tool_call", (event) => ownership.toolCall(event));
	pi.on("tool_result", (event) => ownership.toolResult(event));
	pi.on("session_shutdown", async () => {
		ownership.clear();
		await state.shutdown();
	});
}
