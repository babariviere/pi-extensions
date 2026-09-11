import { pathToFileURL } from "node:url";
import { loadBackgroundAgentsConfig } from "../config.ts";
import { createBackgroundAgentsController, type BackgroundAgentsController } from "./controller.ts";

export async function runBackgroundAgentsController(configPath?: string): Promise<BackgroundAgentsController> {
	const config = loadBackgroundAgentsConfig({ path: configPath, checkPaths: true });
	const controller = createBackgroundAgentsController({ config });
	let stopping: Promise<void> | undefined;
	const stop = async () => {
		if (stopping) return stopping;
		stopping = (async () => {
			await controller.stop();
			controller.database.close();
		})();
		return stopping;
	};
	process.once("SIGINT", () => void stop().then(() => process.exit(0)));
	process.once("SIGTERM", () => void stop().then(() => process.exit(0)));
	await controller.start();
	return controller;
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href === import.meta.url : false;
if (entrypoint) {
	runBackgroundAgentsController(process.env.BACKGROUND_AGENTS_CONFIG).catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
