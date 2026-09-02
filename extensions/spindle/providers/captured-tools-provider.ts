import path from "node:path";
import { runAbortable, throwIfAborted } from "../async-settlement.ts";
import type { AgentToolResult, SourceInfo } from "@earendil-works/pi-coding-agent";
import { CapturedToolCatalog, type CapturedToolEntry } from "../capture/catalog.ts";
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

export class CapturedToolsProvider implements SpindleProvider {
	readonly name = "extensions";
	readonly description = "Tools captured from other Pi extensions and invoked lazily through Spindle";

	readonly #scheduler = new CapturedToolScheduler();

	constructor(
		readonly catalog: CapturedToolCatalog,
		/**
		 * Read-only MCP guardrail. Captured tools are the second way an MCP call can
		 * leave the sandbox: pi-mcp-adapter registers its `mcp` gateway (and any
		 * `directTools`) as ordinary pi tools, which show up here as
		 * `extensions.*`. Without this check `mcp.call` would be guarded and
		 * `extensions.mcp` would not.
		 */
		readonly mcpReadOnlyGate: () => McpReadOnlyGate = () => McpReadOnlyGate.unrestricted(),
	) {}

	async list(
		request: SpindleProviderListRequest,
		_context: SpindleInvocationContext,
	): Promise<SpindleActionDescriptor[]> {
		const query = request.query?.trim().toLowerCase();
		const descriptors = this.catalog.list().map(descriptorFrom);
		if (!query) return descriptors;
		return descriptors.filter((descriptor) =>
			`${descriptor.name} ${descriptor.description} ${descriptor.namespace ?? ""}`.toLowerCase().includes(query),
		);
	}

	async describe(
		actionName: string,
		_context: SpindleInvocationContext,
	): Promise<SpindleActionDescriptor | undefined> {
		const entry = this.catalog.get(actionName);
		if (!entry) return undefined;
		return descriptorFrom(entry);
	}

	prepareArguments(actionName: string, args: Record<string, unknown>): Record<string, unknown> {
		const prepare = this.catalog.require(actionName).wrappedTool.prepareArguments;
		if (!prepare) return args;
		const prepared = prepare(args);
		if (typeof prepared !== "object" || prepared === null || Array.isArray(prepared)) {
			throw new Error(`Captured tool ${actionName} prepared non-object arguments`);
		}
		return prepared as Record<string, unknown>;
	}

	async invoke(
		actionName: string,
		args: Record<string, unknown>,
		context: SpindleInvocationContext,
	): Promise<CapturedToolInvocationResult> {
		const entry = this.catalog.require(actionName);
		this.#assertMcpReadOnly(entry, args);
		return this.#scheduler.run(entry.definition.executionMode, () =>
			runAbortable(context.signal, () => this.#invokeCaptured(entry, args, context)),
		);
	}

	/**
	 * Apply the read-only MCP policy to a captured tool that came from
	 * pi-mcp-adapter. The gateway carries the target in its arguments; a direct
	 * tool is itself the MCP tool name.
	 */
	#assertMcpReadOnly(entry: CapturedToolEntry, args: Record<string, unknown>): void {
		const fromAdapter = entry.name === "mcp" || entry.sourceInfo.path.includes("pi-mcp-adapter");
		if (!fromAdapter) return;
		const gate = this.mcpReadOnlyGate();
		if (!gate.readOnly) return;
		if (entry.name === "mcp") {
			assertMcpGatewayArguments(gate, args);
			return;
		}
		// A namespace proxy (`mcp__slack`) is a gateway for one server: the tool it
		// forwards to is in its arguments, and the server is in its own name.
		const proxied = mcpNamespaceProxyServer(entry.name);
		if (proxied) {
			assertMcpGatewayArguments(gate, args, proxied);
			return;
		}
		gate.assert(entry.name);
	}

	async #invokeCaptured(
		entry: CapturedToolEntry,
		args: Record<string, unknown>,
		context: SpindleInvocationContext,
	): Promise<CapturedToolInvocationResult> {
		const { runner, wrappedTool } = entry;
		const toolCallId = context.nestedToolCallId;
		await runAbortable(context.signal, () =>
			runner.emit({
				type: "tool_execution_start",
				toolCallId,
				toolName: entry.name,
				args,
			}),
		);

		let result: AgentToolResult<unknown>;
		let isError = false;
		let thrown: unknown;
		let updateTail: Promise<void> = Promise.resolve();
		try {
			const preflight = await runAbortable(context.signal, () =>
				runner.emitToolCall({
					type: "tool_call",
					toolName: entry.name,
					toolCallId,
					input: args,
				}),
			);
			context.updateArguments?.(args);
			if (preflight?.block) {
				throw new Error(preflight.reason || `Captured tool ${entry.name} was blocked`);
			}
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
				content: [
					{
						type: "text",
						text: error instanceof Error ? error.message : String(error),
					},
				],
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
			runner.emit({
				type: "tool_execution_end",
				toolCallId,
				toolName: entry.name,
				result,
				isError,
			}),
		);

		if (isError) {
			const text = textFromContent(result.content).trim();
			throw new Error(text || (thrown instanceof Error ? thrown.message : `Captured tool ${entry.name} failed`));
		}
		return asInvocationResult(entry, result, false);
	}
}
