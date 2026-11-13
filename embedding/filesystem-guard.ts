import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { evaluateBashCall } from "../extensions/guardrail/policy.ts";

/** Root-search and catastrophic rm prevention, without manual-edit restrictions. */
export default function filesystemGuard(pi: ExtensionAPI): void {
	pi.on("tool_call", (event) => evaluateBashCall(event, { enabled: true, scope: "filesystem" }));
}
