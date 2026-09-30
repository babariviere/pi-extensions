/** Standalone session-owned shell jobs. No execution runtime or MCP transport. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { actionContext, createActionTool } from "../shared/action-tools.ts";
import { sandboxWrapCommand } from "../sandbox/service.ts";
import { isChildSession } from "../subagents/constants.ts";
import { JobsProvider } from "./jobs-provider.ts";

export default function jobs(pi: ExtensionAPI): void {
	let provider: JobsProvider | undefined;
	let generation = 0;
	let closing: Promise<void> | undefined;
	const definitions = new Map<string, ReturnType<typeof createActionTool>>();

	function shutdown(): Promise<void> {
		if (closing) return closing;
		generation++;
		const old = provider;
		provider = undefined;
		for (const definition of definitions.values()) pi.registerTool({ ...definition, exposure: "hidden" });
		definitions.clear();
		const pending = old?.close() ?? Promise.resolve();
		closing = pending;
		void pending
			.finally(() => {
				if (closing === pending) closing = undefined;
			})
			.catch(() => {});
		return pending;
	}

	pi.on("session_start", async (_event, ctx) => {
		await shutdown();
		if (isChildSession()) return;
		const current = ++generation;
		const active = new JobsProvider(
			(command) => sandboxWrapCommand(pi, command),
			(job) => {
				pi.sendMessage(
					{
						customType: "jobs.result",
						display: true,
						details: job,
						content: `Background job ${job.name} (${job.id}) ${job.state}. Output: ${job.outputPath}${job.error ? `\n${job.error}` : ""}. Use jobs_logs({ id: "${job.id}" }) to inspect it.`,
					},
					{ deliverAs: "followUp", triggerTurn: true },
				);
			},
			() => current === generation && ctx.isIdle(),
		);
		provider = active;
		for (const descriptor of await active.list({}, actionContext(ctx, "jobs-startup"))) {
			if (current !== generation) return;
			const definition = createActionTool(active, descriptor);
			definitions.set(definition.name, definition);
			pi.registerTool(definition);
		}
	});
	pi.on("agent_settled", () => {
		provider?.flushCompletions();
	});
	pi.on("session_shutdown", async () => {
		await shutdown();
	});
}
