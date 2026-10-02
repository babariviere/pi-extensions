import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	Type,
	InMemoryCredentialStore,
	createAssistantMessageEventStream,
	fauxProvider,
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemPrompt,
	type Message,
	type Provider,
} from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createRegistry, Harness, MemoryStorage, type Conversation, GenerationTask } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SandboxSession } from "../sandbox/index.ts";
import { SandboxController, type SandboxSource } from "../sandbox/controller.ts";
import type { SandboxPolicy } from "../sandbox/policy.ts";
import { SANDBOX_MODE_FLAG } from "./constants.ts";
import { builtinAgent } from "./discovery.ts";
import { NativeAdapter, type NativeAdapterOptions } from "./native-adapter.ts";
import type { RunContext, RunRequest } from "./run.ts";

const context = BACKGROUND_CONTEXT;

test("content-only native redaction drops structured data before canonical persistence", async () => {
	await fixture(async ({ open, start, faux }) => {
		const adapter = await open((pi) => {
			pi.registerTool({
				name: "secret_result",
				label: "secret",
				description: "secret test",
				parameters: Type.Object({}),
				outputSchema: Type.Object({ token: Type.String() }),
				execute: async () => ({
					content: [{ type: "text", text: "sensitive" }],
					details: undefined,
					structuredContent: { token: "fixture-secret" },
				}),
			});
			pi.on("tool_result", (event) => {
				if (event.toolName === "secret_result") return { content: [{ type: "text", text: "redacted" }] };
			});
		});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("secret_result", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const { conversation } = await start(adapter);
		const messages = await submit(conversation);
		assert.doesNotMatch(JSON.stringify(messages), /fixture-secret|sensitive/);
		assert.match(JSON.stringify(messages), /redacted/);
	});
});

test("codemode-only presentation hides direct declarations but keeps them callable", async () => {
	await fixture(async ({ open, start, faux }) => {
		const adapter = await open(undefined, {
			settingsManager: SettingsManager.inMemory({ defaultTools: ["+codemode"], codemode: { mode: "only" } }),
		});
		assert.deepEqual(
			adapter.extension.tools?.map((tool) => tool.name),
			["codemode"],
		);
		assert.ok(adapter.session.getCallableToolNames().includes("read"));
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("codemode", { code: "text(ALL_TOOLS.some(t => t.name === 'read'));" })], {
				stopReason: "toolUse",
			}),
			(request) => {
				assert.match(JSON.stringify(request.messages.find((m) => m.role === "toolResult")?.content), /true/);
				return fauxAssistantMessage("done");
			},
		]);
		const { conversation } = await start(adapter);
		await submit(conversation);
	});
});

test("native tool_search publishes newly active tools to durable generation", async () => {
	await fixture(async ({ open, start, faux }) => {
		let calls = 0;
		const adapter = await open((pi) => {
			pi.registerTool({
				name: "discover_widget",
				label: "widget",
				description: "Discover widgets",
				exposure: "deferred",
				annotations: { idempotentHint: true },
				parameters: Type.Object({}),
				execute: async () => {
					calls++;
					return { content: [{ type: "text", text: "widget result" }], details: {} };
				},
			});
		});
		assert.ok(!adapter.extension.tools?.some((tool) => tool.name === "discover_widget"));
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("tool_search", { query: "widgets", limit: 1 })], { stopReason: "toolUse" }),
			(request) => {
				assert.ok(
					request.messages.some(
						(m) => m.role === "system" && m.toolsAdded?.some((tool) => tool.name === "discover_widget"),
					),
				);
				return fauxAssistantMessage([fauxToolCall("discover_widget", {})], { stopReason: "toolUse" });
			},
			fauxAssistantMessage("done"),
		]);
		const { conversation } = await start(adapter);
		await submit(conversation);
		assert.equal(calls, 1);
		assert.equal(adapter.extension.tools?.find((tool) => tool.name === "discover_widget")?.replay, "unsafe");
	});
});

test("native codemode state survives history reset and SQLite/native-kernel replacement", async () => {
	await fixture(async ({ open, faux, directory }) => {
		const path = join(directory, "native-state.sqlite");
		async function reopen(adapter: NativeAdapter) {
			const registry = createRegistry();
			registry.install(adapter.extension);
			adapter.onToolsChanged = (extension) => registry.install(extension);
			const harness = await Harness.open(
				await openNodeSqliteStorage(path),
				{ models: adapter.models, registry, settings: { compaction: { enabled: false } } },
				context,
			);
			const conversation = await harness.root(context, {
				agent: { model: adapter.model, extensions: [adapter.extension] },
			});
			adapter.bindHarness(harness, conversation.id);
			return { harness, conversation };
		}
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("codemode", { code: 'store("remember", 42); text("stored");' })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("stored answer"),
			fauxAssistantMessage([fauxToolCall("codemode", { code: 'text(load("remember"));' })], {
				stopReason: "toolUse",
			}),
			(request) => {
				assert.match(JSON.stringify(request.messages.find((m) => m.role === "toolResult")?.content), /42/);
				return fauxAssistantMessage("restored answer");
			},
		]);
		const first = await open();
		let runtime = await reopen(first);
		try {
			await submit(runtime.conversation);
			await runtime.conversation.reset(undefined, context);
			await runtime.harness.close(context);
			await first.close();
			const second = await open();
			runtime = await reopen(second);
			await submit(runtime.conversation);
			assert.ok(
				second.session.sessionManager
					.getBranch()
					.some((entry) => entry.type === "custom" && entry.customType === "codemode-store"),
			);
		} finally {
			await runtime.harness.close(context);
		}
	});
});
async function fixture(
	run: (f: {
		directory: string;
		request: RunRequest;
		runContext: RunContext;
		options: NativeAdapterOptions;
		faux: ReturnType<typeof fauxProvider>;
		open(factory?: ExtensionFactory, extra?: Partial<NativeAdapterOptions>): Promise<NativeAdapter>;
		start(adapter: NativeAdapter): Promise<{ harness: Harness; conversation: Conversation }>;
	}) => Promise<void>,
) {
	const directory = await mkdtemp(join(tmpdir(), "native-adapter-"));
	const previous = process.env.PI_CODE_MODE_SUBAGENT;
	const previousOffline = process.env.PI_OFFLINE;
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	const argv = [...process.argv];
	process.env.PI_CODE_MODE_SUBAGENT = "1";
	process.env.PI_OFFLINE = "1";
	process.env.PI_CODING_AGENT_DIR = directory;
	const adapters: NativeAdapter[] = [];
	const harnesses: Harness[] = [];
	try {
		const faux = fauxProvider();
		const modelRuntime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			modelsStorePath: join(directory, "models-cache.json"),
			refreshOnCreate: false,
		});
		modelRuntime.registerNativeProvider(faux.provider);
		const request: RunRequest = { agent: builtinAgent(), task: "offline task", index: 0 };
		const runContext: RunContext = {
			sessionId: undefined,
			sessionFile: undefined,
			runId: "test",
			cwd: directory,
			timeoutMs: 10_000,
			projectTrusted: false,
		};
		const options: NativeAdapterOptions = {
			agentDir: directory,
			settingsManager: SettingsManager.inMemory({ defaultTools: ["+codemode", "+tool_search"] }),
			loaderOptions: {
				cwd: directory,
				agentDir: directory,
				noExtensions: true,
				noThemes: true,
				noSkills: true,
				noPromptTemplates: true,
				noContextFiles: true,
				additionalExtensionPaths: ["builtin:codemode", "builtin:tool-search", "builtin:mcp"],
			},
			sessionOptions: { modelRuntime, model: faux.getModel() },
		};
		await run({
			directory,
			request,
			runContext,
			options,
			faux,
			open: async (factory, extra = {}) => {
				const adapter = await NativeAdapter.open(request, runContext, {
					...options,
					...extra,
					loaderOptions: {
						...options.loaderOptions!,
						...extra.loaderOptions,
						extensionFactories: factory ? [factory] : [],
					},
				});
				adapters.push(adapter);
				return adapter;
			},
			start: async (adapter) => {
				const registry = createRegistry();
				registry.install(adapter.extension);
				adapter.onToolsChanged = (extension) => registry.install(extension);
				const harness = await Harness.open(
					new MemoryStorage(),
					{
						models: adapter.models,
						registry,
						settings: { toolExecution: "sequential", compaction: { enabled: false } },
					},
					context,
				);
				harnesses.push(harness);
				const conversation = await harness.root(context, {
					agent: { model: adapter.model, extensions: [adapter.extension] },
				});
				adapter.bindHarness(harness, conversation.id);
				return { harness, conversation };
			},
		});
	} finally {
		for (const harness of harnesses) await harness.close(context);
		for (const adapter of adapters) await adapter.close();
		process.argv.splice(0, process.argv.length, ...argv);
		for (const [name, value] of [
			["PI_CODE_MODE_SUBAGENT", previous],
			["PI_OFFLINE", previousOffline],
			["PI_CODING_AGENT_DIR", previousDir],
		]) {
			if (value === undefined) delete process.env[name!];
			else process.env[name!] = value;
		}
		await rm(directory, { recursive: true, force: true });
	}
}
async function submit(conversation: Conversation, content = "test") {
	const submission = await conversation.submit({ type: "input", content }, context);
	const settled = await submission.wait(context);
	assert.equal(settled.status, "done", JSON.stringify(settled));
	return (await conversation.context(context)).messages;
}

test("native codemode nested calls see canonical assistant, structured output, block and result handlers", async () => {
	await fixture(async ({ open, start, faux }) => {
		let executions = 0;
		const parents: string[] = [];
		const adapter = await open((pi) => {
			pi.registerTool({
				name: "number",
				label: "number",
				description: "Structured number",
				exposure: "codemode",
				annotations: { readOnlyHint: true, idempotentHint: true },
				parameters: Type.Object({ value: Type.Number() }),
				outputSchema: Type.Object({ doubled: Type.Number() }),
				execute: async (_id, args, _signal, _update, ctx) => {
					executions++;
					const branch = ctx.sessionManager.getBranch();
					assert.ok(branch.some((entry) => entry.type === "message" && entry.message.role === "assistant"));
					return {
						content: [{ type: "text", text: "unredacted" }],
						details: { value: args.value },
						structuredContent: { doubled: args.value * 2 },
					};
				},
			});
			pi.registerTool({
				name: "relay",
				label: "relay",
				description: "Nested structured relay",
				exposure: "codemode",
				parameters: Type.Object({}),
				outputSchema: Type.Object({ doubled: Type.Number() }),
				execute: async (_id, _args, _signal, _update, ctx) => {
					const outcome = await ctx.executeTool("number", { value: 3 });
					return outcome.result;
				},
			});
			pi.on("tool_call", (event) => {
				if (event.parentToolCallId) parents.push(event.parentToolCallId);
				if (event.toolName === "number" && event.input.value === 0) return { block: true, reason: "zero refused" };
			});
			pi.on("tool_result", (event) => {
				if (event.toolName === "number" && !event.isError)
					return {
						content: [{ type: "text", text: "redacted" }],
						structuredContent: { doubled: 12 },
						details: { redacted: true },
					};
			});
		});
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("codemode", {
						code: "text(await tools.relay({})); try { await tools.number({value:0}); } catch (e) { text(e.message); }",
					}),
				],
				{ stopReason: "toolUse" },
			),
			(messages) => {
				const result = messages.messages.find((m) => m.role === "toolResult");
				assert.match(JSON.stringify(result?.content), /doubled.*12/);
				assert.match(JSON.stringify(result?.content), /zero refused/);
				assert.doesNotMatch(JSON.stringify(result?.content), /unredacted/);
				return fauxAssistantMessage("finished");
			},
		]);
		const { conversation } = await start(adapter);
		await submit(conversation);
		assert.equal(executions, 1);
		assert.equal(parents.length, 3);
		assert.ok(
			parents.some((id) => id.includes("/")),
			"recursive native nesting keeps parent IDs",
		);
		assert.ok(adapter.extension.tools?.every((tool) => tool.replay === "unsafe"));
		assert.equal(adapter.session.sessionManager.getSessionFile(), undefined);
		assert.equal(adapter.session.isStreaming, false);
		await assert.rejects(adapter.session.prompt("must not generate"), /Only durable Harness/);
	});
});

test("top-level arguments and result handlers compose through durable hooks", async () => {
	await fixture(async ({ open, start, faux }) => {
		const values: number[] = [];
		const adapter = await open((pi) => {
			pi.registerTool({
				name: "echo",
				label: "echo",
				description: "echo",
				parameters: Type.Object({ value: Type.Number() }),
				execute: async (_id, args) => {
					values.push(args.value);
					return { content: [{ type: "text", text: String(args.value) }], details: { original: true } };
				},
			});
			pi.on("tool_call", (event) => {
				if (event.toolName === "echo") {
					if (event.input.value === 0) return { block: true, reason: "blocked" };
					event.input.value = 9;
				}
			});
			pi.on("tool_result", (event) => {
				if (event.toolName === "echo" && !event.isError)
					return { content: [{ type: "text", text: "first" }], details: { patched: true } };
			});
			pi.on("tool_result", (event) => {
				if (event.toolName === "echo" && !event.isError) {
					assert.equal(event.content[0]?.type, "text");
					assert.deepEqual(event.details, { patched: true });
					return { content: [{ type: "text", text: "second" }] };
				}
			});
		});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { value: 1 }), fauxToolCall("echo", { value: 0 })], {
				stopReason: "toolUse",
			}),
			(request) => {
				const results = request.messages.filter((m) => m.role === "toolResult");
				assert.equal(results.length, 2);
				assert.match(JSON.stringify(results[0]?.content), /second/);
				assert.match(JSON.stringify(results[1]?.content), /blocked/);
				return fauxAssistantMessage("done");
			},
		]);
		const { conversation } = await start(adapter);
		await submit(conversation);
		assert.deepEqual(values, [9]);
	});
});

test("native startup hooks run once per input across model and tool rounds", async () => {
	await fixture(async ({ open, start, faux }) => {
		let starts = 0;
		const adapter = await open((pi) => {
			pi.on("before_agent_start", () => {
				starts++;
				pi.appendEntry("startup", starts);
				return { systemPrompt: `native policy ${starts}` };
			});
		});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("codemode", { code: 'text("round one");' })], { stopReason: "toolUse" }),
			(request) => {
				assert.equal(getCurrentSystemPrompt(request.messages), "native policy 1");
				return fauxAssistantMessage("first answer");
			},
			(request) => {
				assert.equal(getCurrentSystemPrompt(request.messages), "native policy 2");
				return fauxAssistantMessage("second answer");
			},
		]);
		const { conversation } = await start(adapter);
		await submit(conversation, "same input");
		assert.equal(starts, 1);
		await submit(conversation, "same input");
		assert.equal(starts, 2, "identical text is still a distinct admitted input");
		assert.equal(
			adapter.session.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === "startup").length,
			2,
		);
	});
});

test("native finalized assistant replacements are canonical before tools and reporting", async () => {
	await fixture(async ({ open, start, faux }) => {
		let effects = 0;
		const adapter = await open((pi) => {
			pi.registerTool({
				name: "should_not_run",
				label: "effect",
				description: "An effect suppressed by a finalized message handler",
				parameters: Type.Object({}),
				execute: async () => {
					effects++;
					return { content: [], details: {} };
				},
			});
			pi.on("message_end", (event) => {
				if (event.message.role === "assistant")
					return {
						message: {
							...event.message,
							content: [{ type: "text", text: "safe final answer" }],
							stopReason: "stop",
						},
					};
			});
		});
		faux.setResponses([
			fauxAssistantMessage([{ type: "text", text: "fixture-sensitive" }, fauxToolCall("should_not_run", {})], {
				stopReason: "toolUse",
			}),
		]);
		const { conversation } = await start(adapter);
		const messages = await submit(conversation);
		assert.equal(effects, 0);
		assert.match(JSON.stringify(messages), /safe final answer/);
		assert.doesNotMatch(
			JSON.stringify(messages.filter((message) => message.role === "assistant")),
			/fixture-sensitive|should_not_run/,
		);
		assert.ok(!messages.some((message) => message.role === "toolResult"));
	});
});

test("saved night sandbox and MCP policies require the native policy extension", async () => {
	await fixture(async ({ open, runContext, directory }) => {
		runContext.nightRun = {
			startedAt: 1,
			reportPath: join(directory, "report.md"),
			maxPullRequests: 1,
			sandbox: { mode: "read-only" },
			mcp: { readOnly: true },
		};
		await assert.rejects(open(), /sandbox extension is absent/);
		delete runContext.nightRun.sandbox;
		await assert.rejects(open(), /sandbox extension is absent/, "MCP-only night policy also fails closed");
	});
});

test("native structured prompts, forced prompts and context changes are request-local", async () => {
	await fixture(async ({ open, start, faux, request }) => {
		request.agent.systemPrompt = "persona";
		const adapter = await open((pi) => {
			pi.on("before_agent_start", (event) => {
				event.systemPromptOptions.sections.worker_rules = "native section";
				return {
					systemPrompt: "forced request only",
					message: { customType: "prep", content: "native start context", display: false },
				};
			});
			pi.on("context", (event) => ({
				messages: [...event.messages, { role: "user", content: "request context", timestamp: 1 }],
			}));
		});
		faux.setResponses([
			(request) => {
				assert.equal(getCurrentSystemPrompt(request.messages), "forced request only");
				assert.match(JSON.stringify(request.messages), /native start context/);
				assert.match(JSON.stringify(request.messages), /request context/);
				return fauxAssistantMessage("done");
			},
		]);
		const { conversation } = await start(adapter);
		const messages = await submit(conversation);
		const canonical = getCurrentSystemPrompt(messages);
		assert.match(canonical, /persona/);
		assert.match(canonical, /<worker_rules>\nnative section/);
		assert.doesNotMatch(JSON.stringify(messages), /forced request only|request context|native start context/);
	});
});

test("native input/templates/skills expand without generation and project trust stays inherited", async () => {
	await fixture(async ({ open, directory, faux }) => {
		await mkdir(join(directory, "prompts"));
		await writeFile(join(directory, "prompts", "review.md"), "Review $1");
		await mkdir(join(directory, "skills", "check"), { recursive: true });
		await writeFile(
			join(directory, "skills", "check", "SKILL.md"),
			"---\nname: check\ndescription: check things\n---\nSkill instructions",
		);
		await mkdir(join(directory, ".pi", "extensions"), { recursive: true });
		await writeFile(
			join(directory, ".pi", "extensions", "untrusted.ts"),
			"export default () => { throw new Error('must not load'); }",
		);
		const adapter = await open(
			(pi) => {
				pi.on("session_start", (_event, ctx) => assert.equal(ctx.isProjectTrusted(), false));
			},
			{
				loaderOptions: {
					cwd: directory,
					agentDir: directory,
					noExtensions: false,
					noSkills: false,
					noPromptTemplates: false,
				},
			},
		);
		assert.equal(await adapter.prepareInput("/review correctness"), "Review correctness");
		assert.match(await adapter.prepareInput("/skill:check now"), /Skill instructions/);
		assert.equal(adapter.session.pendingMessageCount, 0);
		assert.equal(faux.state.callCount, 0);
	});
});

test("Models facade resolves native request-time credentials and request hooks, without caching auth", async () => {
	await fixture(async ({ open, options }) => {
		const runtime = options.sessionOptions!.modelRuntime!;
		let key = "first-secret";
		const seen: string[] = [];
		const provider: Provider = {
			id: "offline-auth",
			name: "offline-auth",
			getModels: () => [{ ...options.sessionOptions!.model!, provider: "offline-auth" }],
			auth: { apiKey: { name: "ephemeral", resolve: async () => ({ auth: { apiKey: key }, source: "offline" }) } },
			stream: (model, _request, options) => {
				const stream = createAssistantMessageEventStream();
				void (async () => {
					seen.push(options?.apiKey ?? "missing");
					assert.equal(options?.headers?.["x-worker"], "yes");
					assert.deepEqual(await options?.onPayload?.({ original: true }, model), { transformed: true });
					const message = { ...fauxAssistantMessage("offline"), provider: model.provider, model: model.id };
					stream.push({ type: "done", reason: "stop", message });
					stream.end(message);
				})();
				return stream;
			},
			streamSimple(model, request, options) {
				return this.stream(model, request, options);
			},
		};
		runtime.registerNativeProvider(provider);
		const adapter = await open((pi) => {
			pi.on("before_provider_request", () => ({ transformed: true }));
			pi.on("before_provider_headers", (event) => {
				event.headers["x-worker"] = "yes";
			});
		});
		const model = adapter.models.getModel(provider.id, options.sessionOptions!.model!.id)!;
		await adapter.models.completeSimple(model, { messages: [] });
		key = "rotated-secret";
		await adapter.models.complete(model, { messages: [] });
		assert.deepEqual(seen, ["first-secret", "rotated-secret"]);
		assert.doesNotMatch(JSON.stringify(adapter.extension), /first-secret|rotated-secret/);
	});
});

test("requested sandbox fails closed when missing, and real native read-only interception also guards codemode", async () => {
	await fixture(async ({ open, start, faux, request, directory }) => {
		request.agent.config.sandbox = "read-only";
		await assert.rejects(open(), /sandbox floor/);
		process.argv.push(`--${SANDBOX_MODE_FLAG}`, "read-only");
		await assert.rejects(open(), /sandbox extension is absent/);
		await assert.rejects(
			open((pi) => {
				pi.registerCommand("sandbox", { description: "not a sandbox", handler: async () => {} });
			}),
			/sandbox extension is absent/,
		);
		// Scratch roots are writable even in read-only mode. Explicitly deny this fixture path.
		await writeFile(join(directory, "sandbox.json"), JSON.stringify({ denyWrite: [".env"] }));
		class OfflineSandbox extends SandboxSession {
			protected override createController(policy: SandboxPolicy, source: SandboxSource) {
				return new SandboxController(policy, source, async () => {
					throw new Error("OS sandbox intentionally unavailable offline");
				});
			}
		}
		const adapter = await open((pi) => {
			const sandbox = new OfflineSandbox(pi);
			pi.on("session_start", (_event, ctx) => sandbox.initialize(ctx));
			pi.on("session_shutdown", () => sandbox.close());
		});
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("codemode", {
						code: 'const r = await Promise.allSettled([tools.write({path:".env",content:"bad"}), tools.bash({command:"echo bad"})]); text(r.map(x => x.status === "rejected" ? x.reason.message : x.value));',
					}),
				],
				{ stopReason: "toolUse" },
			),
			(request) => {
				const result = request.messages.find((m) => m.role === "toolResult");
				assert.match(JSON.stringify(result?.content), /read.only|not writable|write denied|write refused/i);
				assert.match(JSON.stringify(result?.content), /intentionally unavailable/);
				return fauxAssistantMessage("sandbox held");
			},
		]);
		const { conversation } = await start(adapter);
		await submit(conversation);
		await assert.rejects(readFile(join(directory, ".env")), /ENOENT/);
	});
});
