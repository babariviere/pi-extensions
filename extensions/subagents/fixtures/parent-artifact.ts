/** Host-capability fixture. No store or storage paths are available in the child. */
import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, AgentToolResult } from "@earendil-works/pi-coding-agent";

export default function parentArtifact(pi: ExtensionAPI) {
	pi.registerTool({
		name: "artifact",
		label: "Artifact probe",
		description: "Test parent artifact transport",
		parameters: Type.Object({ action: Type.Literal("get"), id: Type.String() }),
		execute: async (_id, args) =>
			new Promise<AgentToolResult<unknown>>((resolve, reject) => {
				const callId = randomUUID();
				const receive = (message: unknown) => {
					const packet = message as { type?: string; callId?: string; result?: unknown; error?: string };
					if (packet?.type !== "artifact.result" || packet.callId !== callId) return;
					process.off("message", receive);
					if (packet.error) reject(new Error(packet.error));
					else resolve({ content: [{ type: "text", text: JSON.stringify(packet.result) }], details: {} });
				};
				process.on("message", receive);
				process.send!({ type: "artifact.call", callId, args: { action: "get", id: args.id } });
			}),
	});
}
