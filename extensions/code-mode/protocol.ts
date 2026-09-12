import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const CODE_MODE_PROVIDER_REGISTER_EVENT = "pi-code-mode:provider:register:v1";
export const CODE_MODE_PROVIDER_DISCOVER_EVENT = "pi-code-mode:provider:discover:v1";

/** Identifies host-side tool lifecycle events replayed for a nested Code Mode call. */
export const CODE_MODE_NESTED_TOOL_CALL_ID_PREFIX = "code_mode_";

/** Discriminant for the transient details envelope on a proxied provider result. */
export const CODE_MODE_TOOL_RESULT_PROXY_KIND = "pi-code-mode.tool-result-proxy.v1";

/**
 * Host-only middleware details for non-Pi Code Mode providers. `result` is the
 * exact value before maxNestedResultChars is enforced and is not persisted as
 * a separate Pi tool-result message.
 */
export interface CodeModeToolResultProxyDetailsV1 {
	kind: typeof CODE_MODE_TOOL_RESULT_PROXY_KIND;
	ref: string;
	result: unknown;
}

export const readCodeModeToolResultProxyDetailsV1 = (value: unknown): CodeModeToolResultProxyDetailsV1 | undefined => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (
		record.kind !== CODE_MODE_TOOL_RESULT_PROXY_KIND ||
		typeof record.ref !== "string" ||
		!Object.hasOwn(record, "result")
	) {
		return undefined;
	}
	return record as unknown as CodeModeToolResultProxyDetailsV1;
};

export type CodeModeActivityEntityKind = "agent" | "actor" | "tool" | "extension" | "mcp" | "mesh" | "task" | "custom";

export type CodeModeInvocationActivityUpdate =
	| { type: "progress"; message: string }
	| { type: "entity"; id: string; kind: CodeModeActivityEntityKind; name?: string }
	| { type: "metrics"; tokens?: number; toolCalls?: number; cost?: number };

export interface CodeModeMediaBlock {
	type: "image";
	data: string;
	mimeType: string;
}

export interface CodeModeActionDescriptor {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	outputSchema?: Record<string, unknown>;
	namespace?: string;
}

export interface CodeModeCapabilityActionHead {
	key: string;
	parentKey: string;
	ref: string;
	name: string;
	description: string;
	descriptorHash: string;
	namespace?: string;
}

export interface CodeModeCapabilityProviderHead {
	key: string;
	parentKey: string;
	name: string;
	description: string;
	descriptorHash: string;
	actions: CodeModeCapabilityActionHead[];
}

export interface CodeModeCapabilityCatalog {
	kind: "pi-code-mode.capability-catalog";
	version: 1;
	root: {
		key: "capability:code-mode";
		name: "Code Mode capabilities";
		description: string;
		descriptorHash: string;
	};
	providers: CodeModeCapabilityProviderHead[];
	totalActions: number;
	indexedActions: number;
	complete: boolean;
	reasons: string[];
}

/** One named action whose declared input schema can be rendered as a guest type. */
export interface CodeModeNamedActionTypeSource {
	name: string;
	inputSchema: Record<string, unknown>;
	outputSchema?: Record<string, unknown>;
}

/** One registered provider and the action schemas returned by its live listing. */
export interface CodeModeProviderTypeSource {
	name: string;
	actions: CodeModeNamedActionTypeSource[];
}

/**
 * Live descriptor snapshot the registry hands to the guest declaration builder
 * so dynamic surfaces get argument checking before the sandbox runs. Absent or
 * empty sections keep the loose static declarations.
 *
 * The `mcp` section is populated only from the on-disk MCP tool cache
 * (mcp/tool-cache.ts), never from a live list: generating types must not
 * connect a server or trigger an OAuth prompt. A server whose tools have never
 * been listed contributes nothing and keeps the loose declarations.
 */
export interface CodeModeGuestTypeSources {
	mcpServers?: CodeModeMcpServerTypeSource[];
	providers?: CodeModeProviderTypeSource[];
}

/** One MCP server's cached tool schemas, for the generated `mcp` surface. */
export interface CodeModeMcpServerTypeSource {
	server: string;
	tools: CodeModeNamedActionTypeSource[];
}

/**
 * Implemented by an MCP provider that can hand over cached tool schemas. Duck
 * typed so an MCP provider without schemas to give (an external one registered
 * through the discovery event) needs no change.
 */
export interface CodeModeMcpTypeSourceProvider {
	mcpGuestTypeSources(context: CodeModeInvocationContext): Promise<CodeModeMcpServerTypeSource[]>;
}

export const isMcpTypeSourceProvider = (value: unknown): value is CodeModeMcpTypeSourceProvider =>
	typeof (value as { mcpGuestTypeSources?: unknown } | null)?.mcpGuestTypeSources === "function";

/**
 * Pre-rendered `declare const` blocks replacing the loose declaration lines.
 * Values are full replacement text (helper interfaces + declare).
 */
export interface CodeModeDynamicGuestDeclarations {
	mcp?: string;
	providers?: Record<string, string>;
}

export interface CodeModeProviderListRequest {
	namespace?: string;
	query?: string;
	limit?: number;
}

export interface CodeModeInvocationContext {
	cwd: string;
	signal: AbortSignal | undefined;
	parentToolCallId: string;
	nestedToolCallId: string;
	extensionContext: ExtensionContext;
	update(message: string): void;
	activity?(update: CodeModeInvocationActivityUpdate): void;
	// Out-of-band image content blocks a provider (currently only pi.read of an
	// image file) wants attached to the call audit, so the single-call render can
	// re-attach them to the code_mode result content for pi core's kitty image
	// preview. Bypasses the result char bound that would truncate the base64.
	// `note` is the read tool's own text output (e.g. "Read image file [image/png]"),
	// captured after any tool_result patch so a handoff that strips pi's
	// non-vision note has run; used as the single-call body + content text so the
	// preview shows the clean note instead of the swapped description.
	attachMedia?(blocks: CodeModeMediaBlock[], note?: string): void;
	// Providers call this after mutable tool_call middleware has run so live and
	// durable audit surfaces reflect the arguments actually passed to the tool.
	updateArguments?(args: Record<string, unknown>): void;
	// Ephemeral renderer-only metadata. It is exposed to live Code Mode previews but
	// never projected into the durable execution trace.
	attachPreview?(preview: unknown): void;
}

export interface CodeModeProvider {
	name: string;
	description: string;
	/**
	 * Hide this provider from orchestration-only code. Built-in `pi` and `web`
	 * providers are always full-code-only; trusted external providers opt in
	 * explicitly instead of being blocked by a closed provider-name list.
	 */
	fullCodeOnly?: boolean;
	list(request: CodeModeProviderListRequest, context: CodeModeInvocationContext): Promise<CodeModeActionDescriptor[]>;
	describe(actionName: string, context: CodeModeInvocationContext): Promise<CodeModeActionDescriptor | undefined>;
	prepareArguments?(
		actionName: string,
		args: Record<string, unknown>,
		context: CodeModeInvocationContext,
	): Record<string, unknown> | Promise<Record<string, unknown>>;
	invoke(actionName: string, args: Record<string, unknown>, context: CodeModeInvocationContext): Promise<unknown>;
	invocationEnded?(parentToolCallId: string): Promise<void>;
	close?(): Promise<void>;
}

export interface CodeModeProviderRegistration {
	version: 1;
	provider: CodeModeProvider;
	overwrite?: boolean;
}

export interface CodeModeProviderDiscovery {
	version: 1;
	register(provider: CodeModeProvider, options?: { overwrite?: boolean }): void;
}
