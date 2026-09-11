import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BackgroundClient, DEFAULT_BACKGROUND_AGENTS_SOCKET, isInteractiveOperatorSession } from "./client.ts";
import { openBackgroundDashboard } from "./ui/dashboard.ts";

function client(): BackgroundClient {
	return new BackgroundClient({
		path: process.env.PI_BACKGROUND_AGENTS_SOCKET ?? DEFAULT_BACKGROUND_AGENTS_SOCKET,
	});
}

export function shouldOpenBackgroundDashboard(
	reason: string,
	mode: string,
	environment: NodeJS.ProcessEnv = process.env,
): boolean {
	return reason === "startup" && isInteractiveOperatorSession(mode, environment);
}

export default function backgroundAgentsExtension(pi: ExtensionAPI): void {
	let dashboardOpening = false;

	const open = async (ctx: ExtensionContext, caseId?: string, automatic = false): Promise<void> => {
		if (ctx.mode !== "tui") {
			if (ctx.hasUI) ctx.ui.notify("Background agents dashboard requires interactive TUI mode", "warning");
			return;
		}
		if (dashboardOpening) return;
		dashboardOpening = true;
		try {
			const dashboardClient = client();
			if (automatic) {
				try {
					const initialSnapshot = await dashboardClient.getDashboard();
					await openBackgroundDashboard(ctx, dashboardClient, "case", caseId, initialSnapshot);
				} catch {
					if (ctx.hasUI) ctx.ui.notify("Background agents dashboard unavailable", "warning");
				}
				return;
			}
			await openBackgroundDashboard(ctx, dashboardClient, "case", caseId);
		} finally {
			dashboardOpening = false;
		}
	};

	pi.registerCommand("background", {
		description: "Open the background-agent dashboard or submit a bug/feature",
		getArgumentCompletions: (prefix) =>
			["bug", "feature", "open", "resume"]
				.filter((value) => value.startsWith(prefix.trim()))
				.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const command = parts[0] ?? "";
			if (command !== "bug" && command !== "feature") {
				const caseId = command === "open" || command === "resume" ? parts[1] : undefined;
				if (command === "resume" && caseId) {
					try {
						await client().action(caseId, "resume");
					} catch (error) {
						if (ctx.hasUI)
							ctx.ui.notify(
								`Unable to resume case: ${error instanceof Error ? error.message : String(error)}`,
								"warning",
							);
						return;
					}
				}
				await open(ctx, caseId);
				return;
			}
			if (ctx.mode !== "tui" || !ctx.hasUI) {
				if (ctx.hasUI) ctx.ui.notify("Submitting background cases requires interactive TUI mode", "warning");
				return;
			}
			const title = await ctx.ui.input(`${command === "bug" ? "Bug" : "Feature"} title`, "Short summary");
			if (!title) return;
			const body = await ctx.ui.editor("Details", "Describe the evidence, objective, and desired outcome.");
			if (body === undefined) return;
			try {
				const result = (await client().submit(`[${command}] ${title}`, body)) as { caseId?: string };
				ctx.ui.notify(`Background case submitted${result.caseId ? `: ${result.caseId}` : ""}`, "info");
			} catch (error) {
				ctx.ui.notify(
					`Background controller unavailable: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			}
		},
	});

	pi.on("session_start", (event, ctx) => {
		if (!shouldOpenBackgroundDashboard(event.reason, ctx.mode, process.env)) return;
		// Do not make startup wait on the socket or custom UI. The editor stays available if it is absent.
		queueMicrotask(() => {
			void open(ctx, undefined, true).catch(() => undefined);
		});
	});

	pi.on("session_shutdown", () => {
		dashboardOpening = false;
	});
}
