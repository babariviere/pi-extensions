import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { evaluateBashCall } from "../extensions/guardrail/policy.ts";

/** Only root searches. Does not enable guardrail's edit or destructive-command restrictions. */
export default function rootSearch(pi: ExtensionAPI): void {
	pi.on("tool_call", (event) => evaluateBashCall(event, { enabled: true, scope: "root-search" }));
}
