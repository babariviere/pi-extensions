import { fileURLToPath } from "node:url";

// Native Node hosts can resolve these paths without importing TypeScript from node_modules.
export const PILOT_EXTENSION_NAMES = Object.freeze([
	"sandbox",
	"apply-patch",
	"web",
	"browser",
	"todos",
	"usage",
	"jobs",
	"subagents",
]);
export const PILOT_PROFILE_PATH = fileURLToPath(new URL("./pilot.ts", import.meta.url));
export const PILOT_CHILD_PROFILE_PATH = fileURLToPath(new URL("./child.ts", import.meta.url));
export const PILOT_WEB_PATH = fileURLToPath(new URL("../extensions/web/index.ts", import.meta.url));

export const SUBAGENTS_SNAPSHOT_EVENT = "subagents:snapshot";
export const SUBAGENTS_REQUEST_SNAPSHOT_EVENT = "subagents:request-snapshot";
export const SUBAGENTS_COMMAND_EVENT = "subagents:command";
export const SUBAGENTS_COMMAND_RESULT_EVENT = "subagents:command-result";
