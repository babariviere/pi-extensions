import { runAbortable } from "../async-settlement.ts";
import type {
  AgentToolResult,
  ExtensionRunner,
} from "@earendil-works/pi-coding-agent";
import {
  SPINDLE_TOOL_RESULT_PROXY_KIND,
  readSpindleToolResultProxyDetailsV1,
  type SpindleToolResultProxyDetailsV1,
} from "../protocol.ts";
import type { ResolvedSpindleAction } from "./action-registry.ts";

type ToolContent = AgentToolResult<unknown>["content"];

export interface SpindleToolResultProxyRequest {
  action: ResolvedSpindleAction;
  args: Record<string, unknown>;
  toolCallId: string;
  value: unknown;
  signal?: AbortSignal;
}

export interface SpindleNestedToolResultProxy {
  proxy(request: SpindleToolResultProxyRequest): Promise<unknown>;
}

const nativeLifecycleProviders = new Set(["pi", "extensions"]);

const textFromContent = (content: ToolContent): string =>
  content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");

const textForValue = (value: unknown): string => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

const valueFromContent = (content: ToolContent): unknown => {
  if (content.every((part) => part.type === "text")) return textFromContent(content);
  return { content };
};

export class SpindleToolResultProxy implements SpindleNestedToolResultProxy {
  constructor(readonly runner: () => ExtensionRunner | undefined) {}

  async proxy(request: SpindleToolResultProxyRequest): Promise<unknown> {
    if (nativeLifecycleProviders.has(request.action.provider)) return request.value;
    const runner = this.runner();
    if (!runner) return request.value;

    const content: ToolContent = [{ type: "text", text: textForValue(request.value) }];
    const details: SpindleToolResultProxyDetailsV1 = {
      kind: SPINDLE_TOOL_RESULT_PROXY_KIND,
      ref: request.action.ref,
      result: request.value,
    };
    const patch = await runAbortable(request.signal, () => runner.emitToolResult({
      type: "tool_result",
      toolName: request.action.ref,
      toolCallId: request.toolCallId,
      input: request.args,
      content,
      details,
      isError: false,
    }));
    if (!patch) return request.value;

    const patchedContent = patch.content ?? content;
    if (patch.isError === true) {
      throw new Error(
        textFromContent(patchedContent).trim() ||
          `Spindle result middleware marked ${request.action.ref} as failed.`,
      );
    }

    const patchedDetails = readSpindleToolResultProxyDetailsV1(patch.details);
    if (
      patchedDetails?.ref === request.action.ref &&
      !Object.is(patchedDetails.result, request.value)
    ) {
      return patchedDetails.result;
    }
    if (patchedContent !== content) return valueFromContent(patchedContent);
    return request.value;
  }
}
