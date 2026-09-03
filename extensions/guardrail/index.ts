/**
 * guardrail
 *
 * A stupid, deliberately blunt safety net for catastrophic bash commands:
 * `rm -rf ~`, `rm -rf /`, `chmod -R 777 /`, `dd of=/dev/disk0`, `mkfs.*`,
 * fork bombs, `curl ... | sh`, `shutdown`, and friends.
 *
 * It blocks the tool call and explains why. It is not a security boundary:
 * matching is token-based, not a real shell parse, and anything sufficiently
 * obfuscated will get through. It exists to catch the dumb mistake, not an
 * adversary.
 *
 * `/guardrail` shows the state, `/guardrail off` disables it for the session
 * (user action only), `/guardrail on` re-enables it.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { evaluateBashCall } from "./policy";
import { checkCommand, defaultContext } from "./rules";

export default function (pi: ExtensionAPI) {
	let enabled = process.env.PI_GUARDRAIL !== "off";

	pi.on("tool_call", async (event, _ctx) => evaluateBashCall(event, { enabled }));

	pi.registerCommand("guardrail", {
		description: "Show or toggle the destructive-command guardrail",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim();
			const verb = arg.toLowerCase();
			if (verb === "off" || verb === "disable") {
				enabled = false;
				ctx.ui.notify("guardrail: disabled for this session", "warning");
				return;
			}
			if (verb === "on" || verb === "enable") {
				enabled = true;
				ctx.ui.notify("guardrail: enabled", "info");
				return;
			}
			if (arg) {
				const hit = checkCommand(arg, defaultContext());
				const message = hit ? `guardrail: would block (${hit.reason})` : "guardrail: would allow";
				ctx.ui.notify(message, hit ? "warning" : "info");
				return;
			}
			const state = enabled ? "enabled" : "disabled";
			ctx.ui.notify(`guardrail: ${state} (use /guardrail on|off, or /guardrail <command> to test)`, "info");
		},
	});
}
