import type { Context } from "@earendil-works/chord";
import type { Extension, Harness } from "@earendil-works/pi-durable";
/** Requires sequential tool execution per conversation. */
export class ToolDrain {
	prepare(extension: Extension): Extension;
	pause(harness: Harness, context: Context): Promise<void>;
	resume(): void;
}
