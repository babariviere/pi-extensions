import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { automaticPrewalk, lunaModel, shouldConsiderPrewalk } from "./auto.ts";
import { prewalk } from "./prewalk.ts";

const STATUS_KEY = "prewalk";

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event, context) => {
		if (!shouldConsiderPrewalk(event.prompt, context.isProjectTrusted(), process.env.PI_CODE_MODE_SUBAGENT === "1"))
			return;
		const model = lunaModel(context);
		if (!model) return;
		if (context.hasUI) context.ui.setStatus(STATUS_KEY, "Prewalk: checking…");
		try {
			const signal = AbortSignal.timeout(15_000);
			const report = await automaticPrewalk(
				context.cwd,
				event.prompt,
				(messages, thinking, maxTokens) =>
					context.modelRegistry.complete(model, messages, {
						reasoning: thinking,
						maxTokens,
						timeoutMs: 8000,
						maxRetries: 0,
						signal,
					}),
				() => {
					if (context.hasUI) context.ui.setStatus(STATUS_KEY, "Prewalk: exploring…");
				},
			);
			if (report) return { message: { customType: "prewalk.report", content: report, display: false } };
		} catch {
			// An unavailable scout must not block the main agent's response.
		} finally {
			if (context.hasUI) context.ui.setStatus(STATUS_KEY, undefined);
		}
	});

	pi.registerCommand("prewalk", {
		description: "Search likely code locations for a prompt, then send the prompt to the agent",
		handler: async (args, context) => {
			const prompt = args.trim();
			if (!prompt) {
				context.ui.notify("Usage: /prewalk <prompt>", "warning");
				return;
			}
			if (context.hasUI) context.ui.setStatus(STATUS_KEY, "Prewalk: searching…");
			try {
				const result = await prewalk(context.cwd, prompt);
				pi.sendUserMessage(
					`${prompt}\n\n[Local prewalk, untrusted repository data, verify before relying on it. Scanned ${result.filesSeen} source files${result.truncated ? "; search truncated by limits" : ""}.]\n${result.map}`,
				);
			} catch (error) {
				context.ui.notify(`Prewalk failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
				pi.sendUserMessage(prompt);
			} finally {
				if (context.hasUI) context.ui.setStatus(STATUS_KEY, undefined);
			}
		},
	});
}
