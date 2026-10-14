import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import sandbox from "../extensions/sandbox/index.ts";
import applyPatch from "../extensions/apply-patch/index.ts";
import web from "../extensions/web/index.ts";
import browser from "../extensions/browser/index.ts";
import todos from "../extensions/todos/index.ts";

export { sandbox, applyPatch, web, browser, todos };

/** Children retain tools and policy, but never own jobs, further subagents or account pollers. */
export default function pilotChild(pi: ExtensionAPI): void {
	for (const factory of [sandbox, applyPatch, web, browser, todos]) factory(pi);
}
