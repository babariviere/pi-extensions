/** Harness owns the conversation, generation loop, and checkpointed delivery tasks. */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	configure,
	createRegistry,
	defineDoc,
	defineExtension,
	defineTask,
	Harness,
	type Conversation,
	type ConversationId,
	type EntryId,
	type Extension,
	type ModelRef,
	type Registry,
	type Storage,
	type TaskId,
} from "@earendil-works/pi-durable";

const context = BACKGROUND_CONTEXT;
export type ConversationResult = { conversationId: ConversationId; output: string; ok: boolean; error?: string };
type Admission = {
	reporterId: TaskId<ConversationResult>;
	content: string;
	answer?: EntryId;
	result?: ConversationResult;
};
const RuntimeDoc = defineDoc<{
	child?: ConversationId;
	anchor?: TaskId;
	requests: Record<string, Admission>;
	reports: Record<string, EntryId>;
}>({
	kind: "subagents.conversation-runtime",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ requests: {}, reports: {} }),
});
const background = { ownership: { kind: "conversation" }, background: true } as const;
const requestKey = (id: string) => `request:${id}`;

const Anchor = defineTask<null, { phase: "done" }, null>({
	name: "subagents.conversation-anchor",
	version: 1,
	initial: () => ({ phase: "done" }),
	phases: {
		done: (_task, runtime, ctx) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx),
	},
	abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});

type ReporterInput = { requestId: string; conversationId: ConversationId; content: string };
type ReporterState = { phase: "deliver" } | { phase: "report"; result: ConversationResult };
const Reporter = defineTask<ReporterInput, ReporterState, ConversationResult>({
	name: "subagents.conversation-reporter",
	version: 1,
	initial: () => ({ phase: "deliver" }),
	phases: {
		deliver: async (task, runtime, ctx) => {
			const { conversationId, requestId, content } = task.input;
			const child = await runtime.conversation(conversationId, ctx);
			if (!child) throw new Error(`Missing durable child ${conversationId}`);
			const submission = await child.submit({ type: "input", content, requestId, whenBusy: "followUp" }, ctx);
			const settled = await submission.wait(ctx);
			await runtime.commit(async (tx) => {
				const admission = (await tx.doc(RuntimeDoc, runtime.conversationId)).requests[requestKey(requestId)]!;
				let result: ConversationResult;
				if (settled.status === "done" && settled.type === "input") {
					const answer = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0];
					const output =
						answer?.role === "assistant"
							? answer.content
									.flatMap((part) => (part.type === "text" ? [part.text] : []))
									.join("")
									.trim()
							: "";
					result = {
						conversationId,
						output,
						ok: output.length > 0,
						...(!output ? { error: "No output produced" } : {}),
					};
					admission.answer = settled.answer;
				} else {
					result = {
						conversationId,
						output: "",
						ok: false,
						error: settled.status === "unanswered" ? settled.reason : "No answer",
					};
				}
				// The answer and report decision checkpoint are one atomic durable write.
				admission.result = result;
				return { status: "running", checkpoint: { phase: "report", result } };
			}, ctx);
		},
		report: async (task, runtime, ctx) => {
			await runtime.commit(async (tx) => {
				const state = await tx.doc(RuntimeDoc, runtime.conversationId);
				const key = requestKey(task.input.requestId);
				if (!Object.hasOwn(state.reports, key)) {
					// Passive entry, not input: the root surrogate must never generate a reply.
					const entry = await tx.appendEntry(runtime.conversationId, {
						kind: "subagents.report",
						data: { requestId: task.input.requestId, ...task.state.checkpoint.result },
					});
					state.reports[key] = entry.id;
				}
				// Entry, deduplication marker, and terminal receipt cannot diverge on a crash.
				return { status: "terminal", outcome: { status: "completed", result: task.state.checkpoint.result } };
			}, ctx);
		},
	},
	abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});
const RuntimeExtension = defineExtension({ name: "subagents.conversation-runtime", tasks: [Anchor, Reporter] });

export interface ConversationRuntimeOptions {
	models: Models;
	extension: Extension;
	cwd: string;
	model: ModelRef;
	thinkingLevel?: ModelThinkingLevel;
}

export class ConversationRuntime {
	private closing?: Promise<void>;
	private cancelled = false;
	private cancelling?: Promise<void>;
	private constructor(
		readonly harness: Harness,
		readonly root: Conversation,
		readonly child: Conversation,
		private readonly registry: Registry,
	) {}

	get conversationId(): ConversationId {
		return this.child.id;
	}

	static async open(storage: Storage, options: ConversationRuntimeOptions): Promise<ConversationRuntime> {
		const registry = createRegistry();
		// Arbitrary native tools are unsafe even if their annotations claim idempotence.
		registry.install({
			...options.extension,
			tools: options.extension.tools?.map((tool) => ({ ...tool, replay: "unsafe" })),
		});
		registry.install(RuntimeExtension);
		const harness = await Harness.open(
			storage,
			{ models: options.models, registry, settings: { toolExecution: "sequential" } },
			context,
		);
		try {
			const root = await harness.root(context, { agent: { extensions: [RuntimeExtension], tools: [] } });
			const childId = await root.commit(async (tx) => {
				const state = await tx.doc(RuntimeDoc, root.id);
				if (state.child) return state.child;
				const anchor = await tx.createTask(Anchor, null, background);
				const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
				await configure(tx, child.id, {
					model: options.model,
					thinkingLevel: options.thinkingLevel,
					cwd: options.cwd,
					extensions: [options.extension, RuntimeExtension],
					tools: null,
				});
				state.child = child.id;
				state.anchor = anchor;
				return child.id;
			}, context);
			const child = await harness.conversation(childId, context);
			if (!child) throw new Error(`Missing durable child ${childId}`);
			// Bind the native kernel before resume(), so reopened tools cannot race binding.
			return new ConversationRuntime(harness, root, child, registry);
		} catch (error) {
			await harness.close(context);
			throw error;
		}
	}

	resume(): void {
		this.harness.resume();
	}

	/** Reuse persisted native input expansion on recovery, without rerunning input handlers. */
	async admittedContent(requestId: string): Promise<string | undefined> {
		const state = await this.harness.snapshot(RuntimeDoc, this.root.id, context);
		return state?.requests[requestKey(requestId)]?.content;
	}

	/** Native MCP/tool_search loadout updates keep replay safety at this boundary. */
	installExtension(extension: Extension): void {
		this.registry.install({ ...extension, tools: extension.tools?.map((tool) => ({ ...tool, replay: "unsafe" })) });
	}

	async run(requestId: string, content: string): Promise<ConversationResult> {
		if (this.closing || this.cancelled) throw new Error("Conversation runtime is stopped");
		const id = await this.root.commit(async (tx) => {
			const state = await tx.doc(RuntimeDoc, this.root.id);
			const key = requestKey(requestId);
			if (Object.hasOwn(state.requests, key)) {
				const existing = state.requests[key]!;
				if (existing.content !== content) throw new Error(`Request ID reused with different content: ${requestId}`);
				return existing.reporterId;
			}
			const reporterId = await tx.createTask(
				Reporter,
				{ requestId, conversationId: this.child.id, content },
				background,
			);
			state.requests[key] = { reporterId, content };
			return reporterId;
		}, context);
		const { outcome } = (await this.harness.waitForTask(id, context)).state;
		return outcome.status === "completed"
			? outcome.result
			: {
					conversationId: this.child.id,
					output: "",
					ok: false,
					error: outcome.status === "failed" ? "Reporter failed" : outcome.status,
				};
	}

	/** Explicit cancellation crosses background boundaries; ordinary close never does. */
	cancel(): Promise<void> {
		this.cancelled = true;
		return (this.cancelling ??= (async () => {
			await this.root.abort(context, { background: true });
			// The anchor may already be terminal, so also abort the persistent child explicitly.
			await this.child.abort(context, { background: true });
		})());
	}

	close(): Promise<void> {
		return (this.closing ??= this.harness.close(context));
	}
}
