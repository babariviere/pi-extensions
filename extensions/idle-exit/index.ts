import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function idleExit(pi: ExtensionAPI): void {
	pi.registerShortcut("ctrl+d", {
		description: "Exit when idle and the editor is empty",
		handler: (ctx) => {
			if (!ctx.isIdle() || ctx.ui.getEditorText().length !== 0) return;
			// Pi 0.86.1's shortcut context defers ctx.shutdown() until the next agent turn.
			// SIGTERM uses Pi's registered graceful shutdown handler immediately.
			process.kill(process.pid, "SIGTERM");
		},
	});
}
