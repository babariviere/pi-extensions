/** Native SDK resources and tool pipeline, without the SDK's model loop or persistent history. */
import type { Context as TaskContext, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import {
	contentText,
	createAssistantMessageEventStream,
	getCurrentTools,
	type AssistantMessage,
	type Message,
	type Models,
	type ModelsApiStreamOptions,
	type ModelsSimpleStreamOptions,
	type ToolCall,
	type AssistantMessageEventStream,
	type Api,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	createCodemodeExtension,
	createMcpExtension,
	createToolSearchExtension,
	DefaultResourceLoader,
	getAgentDir,
	resolveCliModel,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type AgentToolResult,
	type CreateAgentSessionOptions,
	type ExtensionFactory,
	wrapRegisteredTool,
} from "@earendil-works/pi-coding-agent";
import {
	GenerationTask,
	defineDoc,
	hook,
	section,
	ToolTask,
	type ConversationId,
	type Extension,
	type Harness,
	type ToolExecutionResult,
	type ToolRegistration,
	type ModelRef,
	type JsonObject,
} from "@earendil-works/pi-durable";
import { agentSandboxFloor } from "../sandbox/agent-floor.ts";
import { runCwd, type RunContext, type RunRequest } from "./run.ts";

type LoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];
/** Optional dependency injection for offline tests and worker-owned SDK services. */
export interface NativeAdapterOptions {
	agentDir?: string;
	settingsManager?: SettingsManager;
	loaderOptions?: LoaderOptions;
	sessionOptions?: Pick<CreateAgentSessionOptions, "modelRuntime" | "model" | "customTools">;
}

interface NativeMetadata {
	details?: JsonValue;
	structuredContent?: JsonValue;
}
type NativePrompt = {
	key: string;
	rendered: string;
	forced?: string;
	messages: JsonValue[];
};
// Native appendEntry state (including codemode store writes) is not model history. Keep it
// in a Harness document so compaction, reset and worker replacement do not discard it.
const NativeState = defineDoc<{ entries: Array<{ customType: string; data?: JsonValue }>; prompt?: NativePrompt }>({
	kind: "subagents.native-state",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ entries: [] }),
});
const METADATA = "__piNativeAdapter";
function json(value: unknown): JsonValue | undefined {
	return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
function metadata(details: unknown): NativeMetadata | undefined {
	return details && typeof details === "object" && METADATA in details
		? (details as Record<string, NativeMetadata>)[METADATA]
		: undefined;
}
function nativeResult(result: ToolExecutionResult): AgentToolResult<unknown> {
	const meta = metadata(result.details);
	return {
		content: result.content ?? [],
		details: meta ? meta.details : result.details,
		structuredContent: meta?.structuredContent,
		isError: result.isError,
		usage: result.usage,
		terminate: result.control?.terminate,
	};
}
function durableResult(result: AgentToolResult<unknown>): ToolExecutionResult {
	const details = json(result.details);
	const structuredContent = json(result.structuredContent);
	return {
		content: result.content,
		...(result.isError === undefined ? {} : { isError: result.isError }),
		...(structuredContent !== undefined
			? {
					details: {
						[METADATA]: {
							...(details === undefined ? {} : { details }),
							...(structuredContent === undefined ? {} : { structuredContent }),
						},
					},
				}
			: details === undefined
				? {}
				: { details }),
		...(result.usage ? { usage: result.usage } : {}),
		...(result.terminate ? { control: { terminate: true } } : {}),
	};
}

export class NativeAdapter {
	readonly models: Models;
	/** Republish this extension when native tools change (MCP startup or tool_search). */
	onToolsChanged?: (extension: Extension) => void;
	extension!: Extension;
	#harness?: Harness;
	#conversationId?: ConversationId;
	#closed = false;
	#renderPrompt?: () => string;
	#forcedPrompt?: string;
	#startMessages: Message[] = [];
	#toolFingerprint = "";
	#inputKey = "";

	private constructor(
		readonly session: AgentSession,
		private readonly request: RunRequest,
	) {
		// Bind every ordinary Models operation to its native runtime. In particular, getAuth and
		// stream never snapshot credentials. No second credential store or auth-resolution layer.
		this.models = new Proxy(session.modelRuntime, {
			get: (target, key) => {
				if (key === "streamSimple")
					return (
						model: Parameters<Models["streamSimple"]>[0],
						context: Parameters<Models["streamSimple"]>[1],
						options?: ModelsSimpleStreamOptions,
					) => {
						this.assertOpen();
						return this.requestStream(
							() =>
								session.extensionRunner
									.getModelRegistry()
									.streamSimple(model, context, this.requestOptions(options)),
							model,
							options?.signal,
						);
					};
				if (key === "stream")
					return (
						model: Parameters<Models["stream"]>[0],
						context: Parameters<Models["stream"]>[1],
						options?: ModelsApiStreamOptions<Api>,
					) => {
						this.assertOpen();
						return this.requestStream(
							() =>
								// Instrument shared fields; the spread preserves provider-specific options unchanged.
								session.extensionRunner
									.getModelRegistry()
									.stream(model, context, this.requestOptions(options as ModelsSimpleStreamOptions)),
							model,
							options?.signal,
						);
					};
				if (key === "completeSimple")
					return (...args: Parameters<Models["streamSimple"]>) => this.models.streamSimple(...args).result();
				if (key === "complete")
					return (...args: Parameters<Models["stream"]>) => this.models.stream(...args).result();
				const value = Reflect.get(target, key, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	}

	static async open(
		request: RunRequest,
		context: RunContext,
		options: NativeAdapterOptions = {},
	): Promise<NativeAdapter> {
		if (process.env.PI_CODE_MODE_SUBAGENT !== "1")
			throw new Error("NativeAdapter requires an isolated subagent worker");
		const floor = agentSandboxFloor();
		if (request.agent.config.sandbox && floor?.mode !== request.agent.config.sandbox)
			throw new Error("Requested sandbox floor is missing or differs from worker argv");
		const cwd = runCwd(request, context);
		const agentDir = options.agentDir ?? getAgentDir();
		const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
		settingsManager.applyOverrides({
			cacheWarming: "off",
			compaction: { enabled: false },
			retry: { enabled: false },
		});
		let renderPrompt: (() => string) | undefined;
		const capture: ExtensionFactory = (pi) => {
			// Last inline handler retains the public event's SDK-rendered prompt getter. Calling it
			// after dispatch avoids duplicating the native prompt renderer or importing internals.
			pi.on("before_agent_start", (event) => {
				renderPrompt = () => event.systemPrompt;
			});
		};
		const loader = new DefaultResourceLoader({
			...options.loaderOptions,
			cwd,
			agentDir,
			settingsManager,
			noSkills: request.agent.config.inheritSkills === false || options.loaderOptions?.noSkills,
			noContextFiles: request.agent.config.inheritProjectContext === false || options.loaderOptions?.noContextFiles,
			...(request.agent.systemPrompt.trim()
				? request.agent.config.systemPromptMode === "append"
					? { appendSystemPromptOverride: (base: string[]) => [...base, request.agent.systemPrompt] }
					: { systemPrompt: request.agent.systemPrompt }
				: {}),
			extensionFactories: [
				{ name: "codemode", builtin: true, replaceable: true, factory: createCodemodeExtension() },
				{ name: "tool-search", builtin: true, replaceable: true, factory: createToolSearchExtension() },
				{ name: "mcp", builtin: true, replaceable: true, factory: createMcpExtension() },
				...(options.loaderOptions?.extensionFactories ?? []),
				capture,
			],
		});
		await loader.reload({ resolveProjectTrust: async () => context.projectTrusted === true });
		const failures = loader.getExtensions().errors;
		if (failures.length)
			throw new Error(`Native extension loading failed: ${failures.map((e) => e.error).join("; ")}`);
		const { session } = await createAgentSession({
			...options.sessionOptions,
			cwd,
			agentDir,
			settingsManager,
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(cwd),
		});
		const adapter = new NativeAdapter(session, request);
		adapter.#renderPrompt = () => renderPrompt?.() ?? session.systemPrompt;
		const noGeneration = async (): Promise<never> => {
			throw new Error("Only durable Harness may run the worker model loop");
		};
		session.prompt = noGeneration;
		session.agent.prompt = noGeneration;
		session.agent.continue = noGeneration;
		session.compact = noGeneration;
		try {
			const errors: string[] = [];
			await session.bindExtensions({
				mode: "print",
				onError: (error) => errors.push(`${error.event}: ${error.error}`),
			});
			if (errors.length) throw new Error(`Native extension startup failed: ${errors.join("; ")}`);
			if (
				(floor || request.agent.config.sandbox || context.nightRun?.sandbox || context.nightRun?.mcp?.readOnly) &&
				!loader
					.getExtensions()
					.extensions.some(
						(extension) =>
							extension.commands.has("sandbox") &&
							extension.handlers.has("tool_call") &&
							extension.handlers.has("session_start"),
					)
			)
				throw new Error("Sandbox requested but native sandbox extension is absent");
			const modelName = request.overrides?.model ?? request.agent.config.model;
			if (modelName) {
				const resolved = resolveCliModel({ cliModel: modelName, modelRuntime: session.modelRuntime });
				if (!resolved.model || resolved.error)
					throw new Error(resolved.error ?? `Unknown native model: ${modelName}`);
				await session.setModel(resolved.model);
				if (resolved.thinkingLevel) session.setThinkingLevel(resolved.thinkingLevel);
			}
			const thinking = request.overrides?.thinking ?? request.agent.config.thinking;
			if (thinking) {
				if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinking))
					throw new Error(`Invalid thinking level: ${thinking}`);
				session.setThinkingLevel(thinking as AgentSession["thinkingLevel"]);
			}
			adapter.refreshTools();
			return adapter;
		} catch (error) {
			await adapter.close();
			throw error;
		}
	}

	get model(): ModelRef {
		const model = this.session.model;
		if (!model) throw new Error("Native worker has no configured model");
		return { provider: model.provider, modelId: model.id };
	}
	get thinkingLevel() {
		return this.session.thinkingLevel;
	}
	bindHarness(harness: Harness, conversationId: ConversationId): void {
		this.assertOpen();
		if (this.#harness && (this.#harness !== harness || this.#conversationId !== conversationId))
			throw new Error("Native worker cannot be shared between conversations");
		this.#harness = harness;
		this.#conversationId = conversationId;
	}
	private assertOpen(): void {
		if (this.#closed) throw new Error("Native adapter is closed");
	}
	private async sync(context: TaskContext): Promise<Message[]> {
		this.assertOpen();
		if (!this.#harness || !this.#conversationId) throw new Error("Native adapter must bindHarness before execution");
		const conversation = await this.#harness.conversation(this.#conversationId, context);
		if (!conversation) throw new Error("Native adapter conversation is missing");
		const view = await conversation.context(context);
		// Entry identity survives model retries and worker replacement. Native startup hooks
		// run once per admitted input, not once per model/tool round.
		this.#inputKey = String(view.head?.id ?? 0);
		for (let i = view.entries.length - 1; i >= 0; i--) {
			if (view.contributions[i]?.some((message) => message.role === "user")) {
				this.#inputKey = String(view.entries[i]!.id);
				break;
			}
		}
		// Rebuild, not append: edits, resets and compaction belong exclusively to Harness. Keep
		// the SDK session identity stable for sandbox/secret registrations and clear old roots.
		const manager = this.session.sessionManager;
		manager.newSession({ id: manager.getSessionId() });
		const state = await this.#harness.snapshot(NativeState, this.#conversationId, context);
		for (const entry of state?.entries ?? []) manager.appendCustomEntry(entry.customType, entry.data);
		for (const message of view.messages) {
			const meta = message.role === "toolResult" ? metadata(message.details) : undefined;
			const mirrored =
				message.role === "toolResult" && meta
					? { ...structuredClone(message), details: meta.details }
					: structuredClone(message);
			manager.appendMessage(mirrored);
		}
		this.session.agent.state.messages = manager.buildSessionContext().messages;
		const restored = getCurrentTools(view.messages).map((tool) => tool.name);
		if (restored.some((name) => !this.session.getActiveToolNames().includes(name))) {
			this.session.setActiveToolsByName([...this.session.getActiveToolNames(), ...restored]);
			this.refreshTools();
		}
		return structuredClone([...view.messages]);
	}
	private async persistCustomEntries(before: Set<string>, context: TaskContext, prompt?: NativePrompt): Promise<void> {
		const entries = this.session.sessionManager
			.getEntries()
			.flatMap((entry) =>
				entry.type === "custom" && !before.has(entry.id)
					? [{ customType: entry.customType, ...(entry.data === undefined ? {} : { data: json(entry.data) }) }]
					: [],
			);
		if (entries.length || prompt)
			await this.#harness!.commit(async (tx) => {
				const state = await tx.doc(NativeState, this.#conversationId!);
				state.entries.push(...entries);
				if (prompt) state.prompt = prompt;
			}, context);
	}
	private async preparePrompt(context: TaskContext): Promise<string> {
		const messages = await this.sync(context);
		const cached = (await this.#harness!.snapshot(NativeState, this.#conversationId!, context))?.prompt;
		if (cached?.key === this.#inputKey) {
			this.#forcedPrompt = cached.forced;
			this.#startMessages = structuredClone(cached.messages) as unknown as Message[];
			return cached.rendered;
		}
		const lastUser = messages.filter((m) => m.role === "user").at(-1);
		const before = new Set(this.session.sessionManager.getEntries().map((entry) => entry.id));
		const result = await this.session.extensionRunner.emitBeforeAgentStart(
			lastUser ? contentText(lastUser.content) : this.request.task,
			undefined,
			this.session.extensionRunner.createCommandContext().getSystemPromptOptions(),
		);
		this.#forcedPrompt = result.systemPromptOptions.forceSystemPrompt;
		result.systemPromptOptions.forceSystemPrompt = undefined;
		const prompt = this.#renderPrompt!();
		result.systemPromptOptions.forceSystemPrompt = this.#forcedPrompt;
		this.#startMessages = result.messages.map((m) => ({ role: "user", content: m.content, timestamp: Date.now() }));
		await this.persistCustomEntries(before, context, {
			key: this.#inputKey,
			rendered: prompt,
			...(this.#forcedPrompt === undefined ? {} : { forced: this.#forcedPrompt }),
			messages: json(this.#startMessages) as JsonValue[],
		});
		this.refreshTools();
		return prompt;
	}
	private lastAssistant(): AssistantMessage {
		for (let i = this.session.messages.length - 1; i >= 0; i--) {
			const message = this.session.messages[i];
			if (message.role === "assistant") return message;
		}
		throw new Error("Canonical history has no calling assistant");
	}
	private toolContext(call: ToolCall) {
		return {
			toolCall: call,
			args: call.arguments,
			assistantMessage: this.lastAssistant(),
			context: { messages: this.session.messages, tools: this.session.agent.state.tools },
		};
	}

	/** Expansion only: steer queues without running, then clear that native queue immediately. */
	async prepareInput(text: string): Promise<string> {
		this.assertOpen();
		try {
			if ((await this.session.steer(text, undefined, { source: "extension" })) === "handled")
				throw new Error("Native extension handled input; no durable input was produced");
			return this.session.getSteeringMessages()[0] ?? text;
		} finally {
			this.session.clearQueue();
		}
	}

	refreshTools(): Extension {
		this.assertOpen();
		// Reapply public presentation hooks only to discover hidden declarations. SDK already
		// applies the descriptions to its wrapped AgentTools; callable native tools remain intact.
		const infos = this.session.getAllTools();
		const registered = infos.flatMap((info) => {
			const definition = this.session.getToolDefinition(info.name);
			return definition
				? [wrapRegisteredTool({ definition, sourceInfo: info.sourceInfo }, this.session.extensionRunner)]
				: [];
		});
		const hidden = new Set<string>();
		for (const tool of this.session.agent.state.tools) {
			const changes = this.session.getToolDefinition(tool.name)?.prepareLoadout?.({
				declared: registered.filter((t) => this.session.getActiveToolNames().includes(t.name)),
				registered,
				callable: registered.filter((t) => this.session.getCallableToolNames().includes(t.name)),
				getExposure: (name) => infos.find((info) => info.name === name)?.exposure ?? "hidden",
				getNamespace: (name) => infos.find((info) => info.name === name)?.namespace,
			});
			for (const name of changes?.hiddenDeclarations ?? []) hidden.add(name);
		}
		const tools: ToolRegistration[] = this.session.agent.state.tools
			.filter((tool) => !hidden.has(tool.name))
			.map((tool) => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
				...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
				...(tool.constrainedSampling ? { constrainedSampling: tool.constrainedSampling } : {}),
				prepareArguments: tool.prepareArguments,
				replay: "unsafe",
				executionMode: "sequential",
				execute: async (args, api, context) => {
					await this.sync(context);
					const current = this.session.agent.state.tools.find((candidate) => candidate.name === tool.name);
					if (!current) throw new Error(`Native tool withdrawn: ${tool.name}`);
					const before = new Set(this.session.sessionManager.getEntries().map((entry) => entry.id));
					try {
						const result = await current.execute(api.callId, args, context.abortSignal, (update) => {
							for (const block of update.content) if (block.type === "text") api.output(block.text);
						});
						await this.persistCustomEntries(before, context);
						return durableResult(result);
					} finally {
						this.refreshTools();
					}
				},
			}));
		const fingerprint = JSON.stringify(
			tools.map(({ execute: _execute, prepareArguments: _prepare, ...declaration }) => declaration),
		);
		if (this.extension && fingerprint === this.#toolFingerprint) return this.extension;
		this.#toolFingerprint = fingerprint;
		this.extension = {
			name: "native",
			tools,
			sections: [section("native", async (_input, context) => this.preparePrompt(context), { tag: false })],
			hooks: [
				hook(GenerationTask, {
					beforeRequest: async (request, _api, context) => {
						// Recovery can enter the durable request phase without re-rendering sections.
						await this.preparePrompt(context);
						const before = new Set(this.session.sessionManager.getEntries().map((entry) => entry.id));
						let messages = await this.session.extensionRunner.emitContext([
							...request.messages,
							...this.#startMessages,
						]);
						await this.persistCustomEntries(before, context);
						if (this.#forcedPrompt !== undefined)
							messages = [
								{
									role: "system",
									content: this.#forcedPrompt,
									toolsAdded: getCurrentTools(messages),
									timestamp: Date.now(),
								},
								...messages.filter((m) => m.role !== "system"),
							];
						return { messages: await this.session.agent.convertToLlm(messages) };
					},
					afterResponse: async (message, _api, context) => {
						await this.sync(context);
						// Native redaction/replacement must happen before Harness records the answer
						// or schedules tools from it. Give handlers the same finalized SDK view.
						const copy = structuredClone(message);
						this.session.agent.state.messages.push(copy);
						const before = new Set(this.session.sessionManager.getEntries().map((entry) => entry.id));
						const replacement = await this.session.extensionRunner.emitMessageEnd({
							type: "message_end",
							message: copy,
						});
						Object.assign(message, replacement ?? copy);
						await this.persistCustomEntries(before, context);
					},
				}),
				hook(ToolTask, {
					beforeTool: async (call, _api, context) => {
						await this.sync(context);
						const before = new Set(this.session.sessionManager.getEntries().map((entry) => entry.id));
						const copy = structuredClone(call);
						const result = await this.session.agent.beforeToolCall?.(this.toolContext(copy), context.abortSignal);
						await this.persistCustomEntries(before, context);
						return result?.block
							? { block: result.reason ?? "Native extension blocked tool" }
							: { arguments: json(copy.arguments) as JsonObject };
					},
					afterTool: async (call, result, _api, context) => {
						await this.sync(context);
						const before = new Set(this.session.sessionManager.getEntries().map((entry) => entry.id));
						const native = nativeResult(result);
						const override = await this.session.agent.afterToolCall?.(
							{ ...this.toolContext(call), result: native, isError: result.isError ?? false },
							context.abortSignal,
						);
						await this.persistCustomEntries(before, context);
						if (!override) return result;
						const merged = {
							...native,
							...Object.fromEntries(Object.entries(override).filter(([, value]) => value !== undefined)),
						};
						if (override.content !== undefined && override.structuredContent === undefined)
							delete merged.structuredContent;
						const { details: _oldDetails, control: oldControl, ...rest } = result;
						return {
							...rest,
							...durableResult(merged),
							...(oldControl
								? { control: { ...oldControl, terminate: merged.terminate ? true : undefined } }
								: {}),
						};
					},
				}),
			],
		};
		this.onToolsChanged?.(this.extension);
		return this.extension;
	}

	private requestStream(
		dispatch: () => AssistantMessageEventStream,
		model: Parameters<Models["streamSimple"]>[0],
		signal?: AbortSignal,
	): AssistantMessageEventStream {
		const stream = createAssistantMessageEventStream();
		void (async () => {
			try {
				if (this.#harness)
					await this.sync(signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT);
				this.assertOpen();
				const source = dispatch();
				for await (const event of source) stream.push(event);
				stream.end(await source.result());
			} catch (error) {
				const message: AssistantMessage = {
					role: "assistant",
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					stopReason: signal?.aborted ? "aborted" : "error",
					timestamp: Date.now(),
					errorMessage: error instanceof Error ? error.message : String(error),
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				};
				stream.push({ type: "error", reason: signal?.aborted ? "aborted" : "error", error: message });
				stream.end(message);
			}
		})();
		return stream;
	}

	private requestOptions(options: ModelsSimpleStreamOptions = {}): ModelsSimpleStreamOptions {
		const runner = this.session.extensionRunner;
		const settings = this.session.settingsManager;
		const retry = settings.getProviderRetrySettings();
		return {
			...options,
			transport: options.transport ?? this.session.agent.transport,
			thinkingBudgets: options.thinkingBudgets ?? this.session.agent.thinkingBudgets,
			timeoutMs: options.timeoutMs ?? retry.timeoutMs ?? (settings.getHttpIdleTimeoutMs() || 2147483647),
			websocketConnectTimeoutMs: options.websocketConnectTimeoutMs ?? settings.getWebSocketConnectTimeoutMs(),
			maxRetries: options.maxRetries ?? retry.maxRetries,
			maxRetryDelayMs: options.maxRetryDelayMs ?? retry.maxRetryDelayMs,
			onPayload: async (
				payload: unknown,
				model: Parameters<NonNullable<ModelsSimpleStreamOptions["onPayload"]>>[1],
			) => runner.emitBeforeProviderRequest((await options?.onPayload?.(payload, model)) ?? payload),
			transformHeaders: async (headers) =>
				runner.emitBeforeProviderHeaders((await options?.transformHeaders?.(headers)) ?? headers),
			onResponse: async (response, model) => {
				await options?.onResponse?.(response, model);
				await runner.emit({ type: "after_provider_response", status: response.status, headers: response.headers });
			},
			onProviderStreamEvent: async (data, model) => {
				await options?.onProviderStreamEvent?.(data, model);
				await runner.emit({
					type: "provider_stream_event",
					data,
					provider: model.provider,
					api: model.api,
					model: model.id,
				});
			},
		};
	}
	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		try {
			await this.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		} finally {
			this.session.dispose();
		}
	}
}
