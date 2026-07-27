import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const SPINDLE_PROVIDER_REGISTER_EVENT = "pi-spindle:provider:register:v1";
export const SPINDLE_PROVIDER_DISCOVER_EVENT = "pi-spindle:provider:discover:v1";

/** Identifies host-side tool lifecycle events replayed for a nested Spindle call. */
export const SPINDLE_NESTED_TOOL_CALL_ID_PREFIX = "spindle_";

/** Discriminant for the transient details envelope on a proxied provider result. */
export const SPINDLE_TOOL_RESULT_PROXY_KIND = "pi-spindle.tool-result-proxy.v1";

/**
 * Host-only middleware details for non-Pi Spindle providers. `result` is the
 * exact value before maxNestedResultChars is enforced and is not persisted as
 * a separate Pi tool-result message.
 */
export interface SpindleToolResultProxyDetailsV1 {
  kind: typeof SPINDLE_TOOL_RESULT_PROXY_KIND;
  ref: string;
  result: unknown;
}

export const readSpindleToolResultProxyDetailsV1 = (
  value: unknown,
): SpindleToolResultProxyDetailsV1 | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.kind !== SPINDLE_TOOL_RESULT_PROXY_KIND ||
    typeof record.ref !== "string" ||
    !Object.prototype.hasOwnProperty.call(record, "result")
  ) {
    return undefined;
  }
  return record as unknown as SpindleToolResultProxyDetailsV1;
};

export type SpindleRisk = "read" | "write" | "execute" | "network" | "agent";
export type SpindleActivityEntityKind =
  | "agent"
  | "actor"
  | "tool"
  | "extension"
  | "mcp"
  | "mesh"
  | "task"
  | "custom";

export type SpindleInvocationActivityUpdate =
  | { type: "progress"; message: string }
  | { type: "entity"; id: string; kind: SpindleActivityEntityKind; name?: string }
  | { type: "metrics"; tokens?: number; toolCalls?: number; cost?: number };

export interface SpindleMediaBlock {
  type: "image";
  data: string;
  mimeType: string;
}

export interface SpindleActionDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  risk: SpindleRisk;
  namespace?: string;
}

export interface SpindleCapabilityActionHead {
  key: string;
  parentKey: string;
  ref: string;
  name: string;
  description: string;
  descriptorHash: string;
  risk: SpindleRisk;
  namespace?: string;
}

export interface SpindleCapabilityProviderHead {
  key: string;
  parentKey: string;
  name: string;
  description: string;
  descriptorHash: string;
  actions: SpindleCapabilityActionHead[];
}

export interface SpindleCapabilityCatalog {
  kind: "pi-spindle.capability-catalog";
  version: 1;
  root: {
    key: "capability:spindle";
    name: "Spindle capabilities";
    description: string;
    descriptorHash: string;
  };
  providers: SpindleCapabilityProviderHead[];
  totalActions: number;
  indexedActions: number;
  complete: boolean;
  reasons: string[];
}

export interface SpindleProviderListRequest {
  namespace?: string;
  query?: string;
  limit?: number;
}

export interface SpindleInvocationContext {
  cwd: string;
  signal: AbortSignal | undefined;
  parentToolCallId: string;
  nestedToolCallId: string;
  extensionContext: ExtensionContext;
  update(message: string): void;
  activity?(update: SpindleInvocationActivityUpdate): void;
  // Out-of-band image content blocks a provider (currently only pi.read of an
  // image file) wants attached to the call audit, so the single-call render can
  // re-attach them to the spindle_exec result content for pi core's kitty image
  // preview. Bypasses the result char bound that would truncate the base64.
  // `note` is the read tool's own text output (e.g. "Read image file [image/png]"),
  // captured after any tool_result patch so a handoff that strips pi's
  // non-vision note has run; used as the single-call body + content text so the
  // preview shows the clean note instead of the swapped description.
  attachMedia?(blocks: SpindleMediaBlock[], note?: string): void;
  // Providers call this after mutable tool_call middleware has run so live and
  // durable audit surfaces reflect the arguments actually passed to the tool.
  updateArguments?(args: Record<string, unknown>): void;
  // Ephemeral renderer-only metadata. It is exposed to live Spindle previews but
  // never projected into the durable execution trace.
  attachPreview?(preview: unknown): void;
}

export interface SpindleProvider {
  name: string;
  description: string;
  list(
    request: SpindleProviderListRequest,
    context: SpindleInvocationContext,
  ): Promise<SpindleActionDescriptor[]>;
  describe(
    actionName: string,
    context: SpindleInvocationContext,
  ): Promise<SpindleActionDescriptor | undefined>;
  prepareArguments?(
    actionName: string,
    args: Record<string, unknown>,
    context: SpindleInvocationContext,
  ): Record<string, unknown> | Promise<Record<string, unknown>>;
  invoke(
    actionName: string,
    args: Record<string, unknown>,
    context: SpindleInvocationContext,
  ): Promise<unknown>;
  invocationEnded?(parentToolCallId: string): Promise<void>;
  close?(): Promise<void>;
}

export interface SpindleProviderRegistration {
  version: 1;
  provider: SpindleProvider;
  overwrite?: boolean;
}

export interface SpindleProviderDiscovery {
  version: 1;
  register(provider: SpindleProvider, options?: { overwrite?: boolean }): void;
}
