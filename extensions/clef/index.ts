import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readExtensionConfig } from "../shared/config.ts";
import { classifyClef } from "./classifier.ts";
import { CLASSIFIER_API, MODEL_SPECS, normalizeClefConfig } from "./config.ts";
import { ClefWorker } from "./worker.ts";

export default function clef(pi: ExtensionAPI): void {
	let config = normalizeClefConfig({});
	let worker = new ClefWorker(config);
	let configError: Error | undefined;
	const register = () =>
		pi.registerProvider("clef", {
			name: "Local Clef (MLX)",
			baseUrl: "http://localhost/clef-stdio",
			apiKey: "local-clef",
			models: [
				{
					type: "classifier",
					id: MODEL_SPECS[config.model].id,
					name: MODEL_SPECS[config.model].name,
					api: CLASSIFIER_API,
					input: ["text"],
					contextWindow: config.maxLength,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				},
			],
			classifiers: {
				[CLASSIFIER_API]: {
					classify: (model, context, options) =>
						classifyClef(
							model,
							context,
							configError
								? {
										request: async () => {
											throw configError;
										},
									}
								: worker,
							options,
							MODEL_SPECS[config.model].id,
						),
				},
			},
		});
	register();
	pi.on("session_start", async (_event, ctx) => {
		await worker.dispose();
		try {
			config = normalizeClefConfig(readExtensionConfig("clef.json", ctx));
			configError = undefined;
			worker = new ClefWorker(config);
			register();
			const current = worker;
			void current.prepare().catch((error: unknown) => {
				if (
					current === worker &&
					current.status !== "stopped" &&
					!(error instanceof Error && error.message.includes("cancelled"))
				)
					ctx.ui.notify(
						error instanceof Error && error.message.includes("/clef install")
							? error.message
							: `${error instanceof Error ? error.message : "Clef is not ready."} Run /clef install to prepare the environment and checkpoint.`,
						"warning",
					);
			});
		} catch (error) {
			configError = error instanceof Error ? error : new Error("Invalid clef.json");
			ctx.ui.notify(configError.message, "warning");
		}
	});
	pi.on("session_shutdown", () => worker.dispose());
	pi.registerCommand("clef", {
		description: "Local classifier status, /clef install to prepare it, or /clef unload to release memory",
		handler: async (args, ctx) => {
			if (args.trim() === "install" || args.trim() === "setup") {
				if (configError) return ctx.ui.notify(configError.message, "error");
				try {
					await worker.prepare(true);
					ctx.ui.notify(
						"Clef Python environment and checkpoint are ready. Weights load on classification.",
						"info",
					);
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : "Clef setup failed", "error");
				}
			} else if (args.trim() === "unload") {
				await worker.unload();
				ctx.ui.notify("Clef unloaded. The next classification loads it again.", "info");
			} else if (!args.trim() || args.trim() === "status") {
				ctx.ui.notify(
					configError?.message ??
						`clef/${MODEL_SPECS[config.model].id}: ${worker.status}. Input limit ${config.maxLength} tokens, MLX limit ${config.memoryLimitGB} GiB.`,
					configError || worker.status.startsWith("setup failed:") ? "warning" : "info",
				);
			} else ctx.ui.notify("Usage: /clef [status|install|setup|unload]", "warning");
		},
	});
}
