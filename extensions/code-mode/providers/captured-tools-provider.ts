import path from "node:path";
import type { AgentToolResult, SourceInfo } from "@earendil-works/pi-coding-agent";
import { runAbortable, throwIfAborted } from "../async-settlement.ts";
import type { CapturedToolCatalog, CapturedToolEntry } from "../capture/catalog.ts";
import { assertMcpGatewayArguments, McpReadOnlyGate, mcpNamespaceProxyServer } from "../mcp/read-only-policy.ts";
import type {
	SpindleActionDescriptor,
	SpindleInvocationContext,
	SpindleProvider,
	SpindleProviderListRequest,
} from "../protocol.ts";

export interface CapturedToolInvocationResult {
	content: AgentToolResult<unknown>["content"];
	text: string;
	details?: unknown;
	isError: boolean;
	terminate?: boolean;
	source: SourceInfo;
}

/**
 * Internal adapter for exact-name Pi core overrides. This is deliberately not
 * a SpindleProvider: only PiToolsProvider can reach it, while the public
 * CapturedToolsProvider exposes the separately registered aliases below.
 */
export class CapturedToolOverrideAdapter {
	readonly #scheduler = new CapturedToolScheduler();

	constructor(
		readonly catalog: CapturedToolCatalog,
		readonly mcpReadOnlyGate: () => McpReadOnlyGate = () => McpReadOnlyGate.unrestricted(),
	) {}

	describe(sourceName: string): SpindleActionDescriptor | undefined {
		const entry = this.catalog.get(sourceName);
		return entry ? descriptorFrom(entry) : undefined;
	}

	prepareArguments(sourceName: string, args: Record<string, unknown>): Record<string, unknown> {
		const prepare = this.catalog.require(sourceName).wrappedTool.prepareArguments;
		if (!prepare) return args;
		const prepared = prepare(args);
		if (typeof prepared !== "object" || prepared === null || Array.isArray(prepared)) {
			throw new Error(`Captured tool ${sourceName} prepared non-object arguments`);
		}
		return prepared as Record<string, unknown>;
	}

	async invoke(
		sourceName: string,
		args: Record<string, unknown>,
		context: SpindleInvocationContext,
	): Promise<CapturedToolInvocationResult> {
		const entry = this.catalog.require(sourceName);
		assertMcpReadOnlyFor(this.mcpReadOnlyGate, entry, args);
		return this.#scheduler.run(entry.definition.executionMode, () =>
			runAbortable(context.signal, () => invokeCaptured(entry, args, context)),
		);
	}
}

const textFromContent = (content: AgentToolResult<unknown>["content"]): string =>
	content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");

const sourceLabel = (sourceInfo: SourceInfo): string => {
	if (sourceInfo.path.startsWith("<")) return sourceInfo.source;
	const segments = sourceInfo.path.split(/[\\/]/);
	const packageSegment = [...segments].reverse().find((segment) => segment.startsWith("pi-"));
	if (packageSegment) return packageSegment;
	const filename = path.basename(sourceInfo.path).replace(/\.[^.]+$/, "");
	if (filename && filename !== "index") return filename;
	return path.basename(path.dirname(sourceInfo.path)) || sourceInfo.source;
};

const descriptorFrom = (entry: CapturedToolEntry): SpindleActionDescriptor => ({
	name: entry.name,
	description: `${entry.definition.description} (captured from ${sourceLabel(entry.sourceInfo)})`,
	inputSchema: entry.definition.parameters as Record<string, unknown>,
	namespace: `extension:${sourceLabel(entry.sourceInfo)}`,
});

const asInvocationResult = (
	entry: CapturedToolEntry,
	result: AgentToolResult<unknown>,
	isError: boolean,
): CapturedToolInvocationResult => ({
	content: result.content,
	text: textFromContent(result.content),
	...(result.details !== undefined ? { details: result.details } : {}),
	isError,
	...(result.terminate !== undefined ? { terminate: result.terminate } : {}),
	source: entry.sourceInfo,
});

class CapturedToolScheduler {
	#sequentialTail: Promise<void> = Promise.resolve();
	readonly #parallel = new Set<Promise<unknown>>();

	run<T>(mode: "sequential" | "parallel" | undefined, operation: () => Promise<T>): Promise<T> {
		if (mode === "sequential") {
			const precedingParallel = [...this.#parallel];
			const result = this.#sequentialTail.then(() => Promise.allSettled(precedingParallel)).then(operation);
			this.#sequentialTail = result.then(
				() => undefined,
				() => undefined,
			);
			return result;
		}

		const result = this.#sequentialTail.then(operation);
		this.#parallel.add(result);
		void result.then(
			() => this.#parallel.delete(result),
			() => this.#parallel.delete(result),
		);
		return result;
	}
}

const assertMcpReadOnlyFor = (
	gateFactory: () => McpReadOnlyGate,
	entry: CapturedToolEntry,
	args: Record<string, unknown>,
): void => {
	const fromAdapter = entry.name === "mcp" || entry.sourceInfo.path.includes("pi-mcp-adapter");
	if (!fromAdapter) return;
	const gate = gateFactory();
	if (!gate.readOnly) return;
	if (entry.name === "mcp") {
		assertMcpGatewayArguments(gate, args);
		return;
	}
	const proxied = mcpNamespaceProxyServer(entry.name);
	if (proxied) {
		assertMcpGatewayArguments(gate, args, proxied);
		return;
	}
	gate.assert(entry.name);
};

const invokeCaptured = async (
	entry: CapturedToolEntry,
	args: Record<string, unknown>,
	context: SpindleInvocationContext,
): Promise<CapturedToolInvocationResult> => {
	const { runner, wrappedTool } = entry;
	const toolCallId = context.nestedToolCallId;
	await runAbortable(context.signal, () =>
		runner.emit({ type: "tool_execution_start", toolCallId, toolName: entry.name, args }),
	);

	let result: AgentToolResult<unknown>;
	let isError = false;
	let thrown: unknown;
	let updateTail: Promise<void> = Promise.resolve();
	try {
		const preflight = await runAbortable(context.signal, () =>
			runner.emitToolCall({ type: "tool_call", toolName: entry.name, toolCallId, input: args }),
		);
		context.updateArguments?.(args);
		if (preflight?.block) throw new Error(preflight.reason || `Captured tool ${entry.name} was blocked`);
		result = await runAbortable(context.signal, () =>
			wrappedTool.execute(toolCallId, args, context.signal, (partialResult) => {
				const progress = textFromContent(partialResult.content).trim();
				if (progress) context.update(`${entry.name}: ${progress.slice(0, 500)}`);
				updateTail = updateTail
					.then(() =>
						runAbortable(context.signal, () =>
							runner.emit({
								type: "tool_execution_update",
								toolCallId,
								toolName: entry.name,
								args,
								partialResult,
							}),
						),
					)
					.catch(() => undefined);
			}),
		);
	} catch (error) {
		thrown = error;
		isError = true;
		result = {
			content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
			details: { capturedToolError: true },
		};
	}

	await updateTail;
	throwIfAborted(context.signal);
	const patch = await runAbortable(context.signal, () =>
		runner.emitToolResult({
			type: "tool_result",
			toolName: entry.name,
			toolCallId,
			input: args,
			content: result.content,
			details: result.details,
			isError,
		}),
	);
	if (patch) {
		result = {
			...result,
			content: patch.content ?? result.content,
			...(patch.details !== undefined ? { details: patch.details } : {}),
		};
		isError = patch.isError ?? isError;
	}

	await runAbortable(context.signal, () =>
		runner.emit({ type: "tool_execution_end", toolCallId, toolName: entry.name, result, isError }),
	);
	if (isError) {
		const text = textFromContent(result.content).trim();
		throw new Error(text || (thrown instanceof Error ? thrown.message : `Captured tool ${entry.name} failed`));
	}
	return asInvocationResult(entry, result, false);
};

export class CapturedToolsProvider implements SpindleProvider {
	readonly name = "web";
	readonly description: string;
	readonly #aliases: Readonly<Record<string, string>>;
	readonly fullCodeOnly = true;
	readonly #adapter: CapturedToolOverrideAdapter;

	constructor(
		readonly catalog: CapturedToolCatalog,
		/**
		 * Read-only MCP guardrail. Captured tools are the second way an MCP call can
		 * leave the sandbox: pi-mcp-adapter registers its `mcp` gateway (and any
		 * `directTools`) as ordinary pi tools, which show up here as
		 * the explicit `web.*` provider. Without this check `mcp.call` would be guarded and
		 * a captured MCP tool exposed through `web.*` would not.
		 */
		readonly mcpReadOnlyGate: () => McpReadOnlyGate = () => McpReadOnlyGate.unrestricted(),
		options: { description?: string; aliases?: Readonly<Record<string, string>> } = {},
	) {
		this.description = options.description ?? "Explicitly registered web capabilities";
		const aliases = Object.create(null) as Record<string, string>;
		for (const [publicName, sourceName] of Object.entries(options.aliases ?? {})) {
			if (typeof sourceName === "string" && sourceName.length > 0) aliases[publicName] = sourceName;
		}
		this.#aliases = aliases;
		this.#adapter = new CapturedToolOverrideAdapter(catalog, mcpReadOnlyGate);
	}

	#sourceName(actionName: string): string | undefined {
		return Object.hasOwn(this.#aliases, actionName) ? this.#aliases[actionName] : undefined;
	}
	#publicName(sourceName: string): string | undefined {
		return Object.entries(this.#aliases).find(([, source]) => source === sourceName)?.[0];
	}

	async list(
		request: SpindleProviderListRequest,
		_context: SpindleInvocationContext,
	): Promise<SpindleActionDescriptor[]> {
		const query = request.query?.trim().toLowerCase();
		const descriptors = this.catalog
			.list()
			.map((entry) => ({ entry, name: this.#publicName(entry.name) }))
			.filter((item): item is { entry: CapturedToolEntry; name: string } => item.name !== undefined)
			.map(({ entry, name }) => ({ ...descriptorFrom(entry), name }));
		if (!query) return descriptors;
		return descriptors.filter((descriptor) =>
			`${descriptor.name} ${descriptor.description} ${descriptor.namespace ?? ""}`.toLowerCase().includes(query),
		);
	}

	async describe(
		actionName: string,
		_context: SpindleInvocationContext,
	): Promise<SpindleActionDescriptor | undefined> {
		const sourceName = this.#sourceName(actionName);
		if (sourceName === undefined) return undefined;
		const descriptor = this.#adapter.describe(sourceName);
		return descriptor ? { ...descriptor, name: actionName } : undefined;
	}

	prepareArguments(actionName: string, args: Record<string, unknown>): Record<string, unknown> {
		const sourceName = this.#sourceName(actionName);
		if (sourceName === undefined) throw new Error(`Unknown captured extension tool: ${actionName}`);
		return this.#adapter.prepareArguments(sourceName, args);
	}

	async invoke(
		actionName: string,
		args: Record<string, unknown>,
		context: SpindleInvocationContext,
	): Promise<CapturedToolInvocationResult> {
		const sourceName = this.#sourceName(actionName);
		if (sourceName === undefined) throw new Error(`Unknown captured extension tool: ${actionName}`);
		return this.#adapter.invoke(sourceName, args, context);
	}
}
