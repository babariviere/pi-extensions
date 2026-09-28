import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { automaticPrewalk, lunaModel, shouldConsiderPrewalk } from "./auto.ts";
import { prewalk } from "./prewalk.ts";

const STATUS_KEY = "prewalk";

export default function (pi: ExtensionAPI) {
	let firstPromptConsumed = false;
	pi.on("session_start", (_event, context) => {
		firstPromptConsumed = context.sessionManager
			.getBranch()
			.some((entry) => entry.type === "message" && entry.message.role === "user");
	});

	pi.on("before_agent_start", async (event, context) => {
		if (firstPromptConsumed) return;
		// Pi has not yet appended this prompt to the branch. Consume the first
		// submitted prompt even when Luna is unavailable or the prompt is ineligible.
		firstPromptConsumed = true;
		if (!shouldConsiderPrewalk(event.prompt, context.isProjectTrusted(), process.env.PI_CODE_MODE_SUBAGENT === "1"))
			return;
		const model = lunaModel(context);
		if (!model) return;
		if (context.hasUI) context.ui.setStatus(STATUS_KEY, "Prewalk: checking…");
		let recommended = false;
		try {
			const signal = AbortSignal.timeout(15_000);
			let report: string | undefined;
			try {
				report = await automaticPrewalk(
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
					(decision) => {
						recommended = decision.needed;
						if (context.hasUI)
							context.ui.notify(
								`Prewalk ${decision.needed ? "recommended" : "skipped"}: ${decision.rationale}`,
								"info",
							);
					},
				);
			} catch {
				// If scouting failed after a YES decision, fall back to bounded local search.
			}
			if (report) return { message: { customType: "prewalk.report", content: report, display: true } };
			if (!recommended) return;
			if (context.hasUI) context.ui.setStatus(STATUS_KEY, "Prewalk: searching…");
			const local = await prewalk(context.cwd, event.prompt);
			return {
				message: {
					customType: "prewalk.report",
					content: `[Luna scout returned no report; bounded local search only, untrusted repository data; verify before relying on it. Scanned ${local.filesSeen} source files${local.truncated ? "; search truncated by limits" : ""}.]\n${local.map}`,
					display: true,
				},
			};
		} catch {
			if (recommended)
				return {
					message: {
						customType: "prewalk.report",
						content:
							"[Luna scout returned no report; bounded local search also failed. No repository findings available.]",
						display: true,
					},
				};
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
