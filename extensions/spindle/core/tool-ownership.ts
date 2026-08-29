import path from "node:path";
import type { ToolCallEvent, ToolCallEventResult, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { readSpindleExecutionTraceV1 } from "../audit/index.ts";
import { NESTED_TOOL_CALL_ID_PREFIX } from "./action-registry.ts";
import { PI_CORE_TOOL_NAME_SET } from "./pi-tools.ts";

export interface SpindleToolOwnershipHost {
	getActiveTools(): string[];
	setActiveTools(names: string[]): void;
}

const SPINDLE_TOOL_NAME = "spindle_exec";

export const ownsSpindleToolSource = (
	tools: Array<{ name: string; sourceInfo: { path: string } }>,
	extensionEntryPath: string,
): boolean =>
	tools.some(
		(tool) =>
			tool.name === SPINDLE_TOOL_NAME && path.resolve(tool.sourceInfo.path) === path.resolve(extensionEntryPath),
	);

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const finalSpindleDetailsFailed = (details: unknown): boolean => {
	if (!isRecord(details)) return false;
	if (details.success === false) return true;
	const trace = readSpindleExecutionTraceV1(details.trace);
	return trace !== undefined && trace.outcome !== "succeeded";
};

export class SpindleToolLifecycle {
	readonly #outerCalls = new Set<string>();

	constructor(readonly ownsSpindleTool: () => boolean) {}

	toolCall(event: ToolCallEvent): ToolCallEventResult | undefined {
		if (event.toolCallId.startsWith(NESTED_TOOL_CALL_ID_PREFIX)) return undefined;
		if (event.toolName === SPINDLE_TOOL_NAME && this.ownsSpindleTool()) {
			this.#outerCalls.add(event.toolCallId);
		}
		return undefined;
	}

	toolResult(event: ToolResultEvent): { isError: true } | undefined {
		if (
			event.toolName !== SPINDLE_TOOL_NAME ||
			event.toolCallId.startsWith(NESTED_TOOL_CALL_ID_PREFIX) ||
			!this.#outerCalls.delete(event.toolCallId)
		) {
			return undefined;
		}
		return !event.isError && finalSpindleDetailsFailed(event.details) ? { isError: true } : undefined;
	}

	clear(): void {
		this.#outerCalls.clear();
	}
}

const sameTools = (left: string[], right: string[]): boolean =>
	left.length === right.length && left.every((name, index) => name === right[index]);

export class SpindleToolOwnership {
	#savedNativeCoreTools: Array<{ name: string; index: number }> | undefined;

	constructor(readonly host: SpindleToolOwnershipHost) {}

	apply(fullCodeMode: boolean): boolean {
		const active = this.host.getActiveTools();
		if (!fullCodeMode) return this.#restore(active);

		this.#savedNativeCoreTools ??= active.flatMap((name, index) =>
			PI_CORE_TOOL_NAME_SET.has(name) ? [{ name, index }] : [],
		);
		const next = active.filter((name) => !PI_CORE_TOOL_NAME_SET.has(name));
		if (!next.includes(SPINDLE_TOOL_NAME)) next.push(SPINDLE_TOOL_NAME);
		return this.#setIfChanged(active, next);
	}

	release(): boolean {
		return this.#restore(this.host.getActiveTools());
	}

	#restore(active: string[]): boolean {
		const saved = this.#savedNativeCoreTools;
		if (!saved) return false;
		this.#savedNativeCoreTools = undefined;
		const next = [...active];
		for (const { name, index } of saved) {
			if (!next.includes(name)) next.splice(Math.min(index, next.length), 0, name);
		}
		return this.#setIfChanged(active, next);
	}

	#setIfChanged(active: string[], next: string[]): boolean {
		if (sameTools(active, next)) return false;
		this.host.setActiveTools(next);
		return true;
	}
}
