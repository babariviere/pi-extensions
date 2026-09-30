/** Accept the parent-set compatibility flag; standalone sandbox reads its argv floor. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SANDBOX_MODE_FLAG } from "./constants.ts";

export default function childFlags(pi: ExtensionAPI): void {
	pi.registerFlag(SANDBOX_MODE_FLAG, {
		type: "string",
		description: "Sandbox mode floor for this subagent (compatibility flag set by the parent).",
	});
}
