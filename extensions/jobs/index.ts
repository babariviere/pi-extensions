/** Standalone session-owned shell jobs. No execution runtime or MCP transport. */
import type { ExtensionAPI, SessionShutdownEvent } from "@earendil-works/pi-coding-agent";
import { actionContext, createActionsTool } from "../shared/action-tools.ts";
import { sandboxWrapCommand } from "../sandbox/service.ts";
import { isChildSession } from "../subagents/constants.ts";
import { JobsProvider, type AnnouncementTiming } from "./jobs-provider.ts";
import { acquireJobs, closeJobs, type JobsSession } from "./job-owners.ts";

export default function jobs(pi: ExtensionAPI, timing: Partial<AnnouncementTiming> = {}): void {
	let provider: JobsProvider | undefined;
	let ref: JobsSession | undefined;
	let generation = 0;
	let closing: Promise<void> | undefined;
	let definition: ReturnType<typeof createActionsTool> | undefined;

	function shutdown(reason?: SessionShutdownEvent["reason"]): Promise<void> {
		generation++;
		if (closing) return closing;
		const old = provider;
		const previousRef = ref;
		provider = undefined;
		ref = undefined;
		if (definition) pi.registerTool({ ...definition, exposure: "hidden" });
		definition = undefined;
		old?.suspend();
		const pending = reason !== "reload" && previousRef ? closeJobs(previousRef) : Promise.resolve();
		closing = pending;
		void pending
			.finally(() => {
				if (closing === pending) closing = undefined;
			})
			.catch(() => {});
		return pending;
	}

	pi.on("session_start", async (event, ctx) => {
		const pending = shutdown(event.reason === "reload" ? "reload" : undefined);
		const current = generation;
		await pending;
		if (current !== generation || isChildSession()) return;
		const session: JobsSession = {
			cwd: ctx.cwd,
			sessionId: ctx.sessionManager.getSessionId(),
			sessionFile: ctx.sessionManager.getSessionFile() || undefined,
		};
		ref = session;
		let active: JobsProvider;
		try {
			active = await acquireJobs(session, timing, () => current === generation);
		} catch (error) {
			if (current !== generation) return;
			ref = undefined;
			throw error;
		}
		if (current !== generation) return;
		active.attach(
			(command) => sandboxWrapCommand(pi, command),
			(completed) => {
				const summary = completed.map(
					(job) =>
						`- ${job.name} (${job.id}): ${job.state}, exit code ${job.exitCode ?? "unknown"}. Output: ${job.outputPath}${job.error ? `\n  ${job.error}` : ""}`,
				);
				pi.sendMessage(
					{
						customType: "jobs.result",
						display: true,
						details: { jobs: completed },
						content: `Finished background jobs:\n${summary.join("\n")}\nUse read or bash with rg/tail on the output paths to inspect output as needed.`,
					},
					{ deliverAs: "followUp", triggerTurn: true },
				);
			},
			() => current === generation && ctx.isIdle(),
			(error) => ctx.ui.notify(`Jobs: ${error.message}`, "error"),
		);
		provider = active;
		const descriptors = await active.list({}, actionContext(ctx, "jobs-startup"));
		if (current !== generation) return;
		const tool = createActionsTool(active, descriptors);
		definition = {
			...tool,
			execute: (...args) => {
				if (current !== generation || provider !== active) throw new Error("Jobs runtime is detached");
				return tool.execute(...args);
			},
		};
		pi.registerTool(definition);
	});
	pi.on("agent_settled", () => {
		provider?.settle();
	});
	pi.on("session_shutdown", async (event) => {
		await shutdown(event.reason);
	});
}
