import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import child from "./child.ts";
import usage from "../extensions/usage/index.ts";
import jobs from "../extensions/jobs/index.ts";
import subagents from "../extensions/subagents/index.ts";

export { sandbox, applyPatch, web, browser, todos } from "./child.ts";
export { usage, jobs, subagents };
export type {
	SubagentHostSnapshot,
	SubagentHostEntry,
	SubagentHostCommand,
	SubagentHostCommandResult,
} from "../extensions/subagents/host-events.ts";

/** Loaded explicitly by embedding hosts, never discovered by a normal Pi installation. */
export default function pilot(pi: ExtensionAPI): void {
	child(pi);
	for (const factory of [usage, jobs, subagents]) factory(pi);
}
