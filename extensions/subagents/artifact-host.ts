/** Optional parent artifact capability. Transport only; storage and authorization belong to the host. */
import { randomUUID } from "node:crypto";

interface EventBus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

export function requestParentArtifact(
	events: EventBus,
	parentSessionId: string,
	name: string,
	args: unknown,
	signal?: AbortSignal,
): Promise<unknown> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Parent artifact bridge closed"));
			return;
		}
		const callId = randomUUID();
		const off = events.on("subagents:artifact-result", (data) => {
			const packet = data as { callId?: unknown; result?: unknown; error?: unknown } | undefined;
			if (packet?.callId !== callId) return;
			clearTimeout(timer);
			off();
			signal?.removeEventListener("abort", abort);
			if (typeof packet.error === "string") reject(new Error(packet.error));
			else resolve(packet.result);
		});
		const abort = () => {
			clearTimeout(timer);
			off();
			signal?.removeEventListener("abort", abort);
			reject(new Error("Parent artifact bridge closed or timed out"));
		};
		const timer = setTimeout(abort, 300_000);
		timer.unref();
		signal?.addEventListener("abort", abort, { once: true });
		events.emit("subagents:artifact-call", { callId, parentSessionId, name, args });
	});
}
