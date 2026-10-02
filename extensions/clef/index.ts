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
		} catch (error) {
			configError = error instanceof Error ? error : new Error("Invalid clef.json");
			ctx.ui.notify(configError.message, "error");
		}
	});
	pi.on("session_shutdown", () => worker.dispose());
	pi.registerCommand("clef", {
		description: "Local classifier status, or /clef unload to release model memory",
		handler: async (args, ctx) => {
			if (args.trim() === "unload") {
				await worker.unload();
				ctx.ui.notify("Clef unloaded. The next classification loads it again.", "info");
			} else if (!args.trim() || args.trim() === "status") {
				ctx.ui.notify(
					configError?.message ??
						`clef/${MODEL_SPECS[config.model].id}: ${worker.status}. Input limit ${config.maxLength} tokens, MLX limit ${config.memoryLimitGB} GiB.`,
					configError ? "error" : "info",
				);
			} else ctx.ui.notify("Usage: /clef [status|unload]", "warning");
		},
	});
}
