/** Harness owns the conversation, generation loop, and checkpointed delivery tasks. */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	AgentDoc,
	AssistantEntry,
	configure,
	createRegistry,
	defineDoc,
	defineExtension,
	defineTask,
	Harness,
	InboxDoc,
	LiveDoc,
	ROOT_CONVERSATION_ID,
	type Conversation,
	type ConversationId,
	type EntryId,
	type Extension,
	type ModelRef,
	type Registry,
	type Storage,
	type TaskId,
} from "@earendil-works/pi-durable";
import type { WorkerAnswer, WorkerStatus } from "./worker-protocol.ts";

const context = BACKGROUND_CONTEXT;
// Protocol interfaces are open to declaration merging. Persist a closed JSON shape.
type DurableAnswer = Omit<WorkerAnswer, "answer"> & {
	answer?: Pick<NonNullable<WorkerAnswer["answer"]>, "id" | "text">;
};
export interface ReporterHandle {
	readonly id: TaskId<WorkerAnswer>;
	wait(): Promise<WorkerAnswer>;
}
type Admission = {
	reporterId: TaskId<WorkerAnswer>;
	content: string;
	followUp: boolean;
	answer?: EntryId;
	result?: DurableAnswer;
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

type ReporterInput = { requestId: string; conversationId: ConversationId; content: string; followUp: boolean };
type ReporterState = { phase: "deliver" } | { phase: "report"; result: DurableAnswer };
const Reporter = defineTask<ReporterInput, ReporterState, WorkerAnswer>({
	name: "subagents.conversation-reporter",
	version: 1,
	initial: () => ({ phase: "deliver" }),
	phases: {
		deliver: async (task, runtime, ctx) => {
			const { conversationId, requestId, content, followUp } = task.input;
			const child = await runtime.conversation(conversationId, ctx);
			if (!child) throw new Error(`Missing durable child ${conversationId}`);
			const submission = await child.submit(
				{ type: "input", content, requestId, whenBusy: followUp ? "followUp" : "steer" },
				ctx,
			);
			const settled = await submission.wait(ctx);
			await runtime.commit(async (tx) => {
				const admission = (await tx.doc(RuntimeDoc, runtime.conversationId)).requests[requestKey(requestId)]!;
				let result: DurableAnswer;
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
						answer: { id: String(settled.answer), text: output },
						ok: output.length > 0,
						...(!output ? { error: "No output produced" } : {}),
					};
					admission.answer = settled.answer;
				} else {
					// Model failures keep their provider diagnostic in the settlement detail.
					let error = "No answer";
					if (settled.status === "unanswered") {
						error = typeof settled.detail === "string" && settled.detail.trim() ? settled.detail : settled.reason;
					}
					result = {
						ok: false,
						...(settled.status === "unanswered" && settled.reason === "aborted" ? { aborted: true } : { error }),
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
				const result = task.state.checkpoint.result;
				const key = result.answer ? `answer:${result.answer.id}` : requestKey(task.input.requestId);
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
	private operations: Promise<unknown> = Promise.resolve();
	private readonly handles = new Map<TaskId<WorkerAnswer>, ReporterHandle>();
	private constructor(
		readonly harness: Harness,
		readonly root: Conversation,
		readonly child: Conversation,
		private readonly registry: Registry,
	) {}

	get conversationId(): ConversationId {
		return this.child.id;
	}

	/** Resolve the persisted model before opening the native kernel with host defaults. */
	static async pinnedAgent(
		storage: Storage,
	): Promise<Pick<ConversationRuntimeOptions, "model" | "thinkingLevel"> | undefined> {
		const stateRecord = await storage.findDocument(
			{
				kind: RuntimeDoc.definition.kind,
				scope: { kind: "conversation", conversationId: ROOT_CONVERSATION_ID },
			},
			"current",
			context,
		);
		if (!stateRecord) return undefined;
		const state = await storage.document(stateRecord.id, "current", context);
		const child = state?.value.child;
		if (typeof child !== "number") return undefined;
		const agentRecord = await storage.findDocument(
			{
				kind: AgentDoc.definition.kind,
				scope: { kind: "conversation", conversationId: child as ConversationId },
			},
			"current",
			context,
		);
		if (!agentRecord) throw new Error("Durable child has no pinned agent");
		const stored = await storage.document(agentRecord.id, "current", context);
		const agent = stored?.value as { model?: ModelRef; thinkingLevel?: ModelThinkingLevel } | undefined;
		if (!agent?.model) throw new Error("Durable child has no pinned model");
		return { model: agent.model, thinkingLevel: agent.thinkingLevel };
	}

	static async open(storage: Storage, options: ConversationRuntimeOptions): Promise<ConversationRuntime> {
		const registry = createRegistry();
		// Arbitrary native tools are unsafe even if their annotations claim idempotence.
		registry.install({
			...options.extension,
			tools: options.extension.tools?.map((tool) => ({ ...tool, replay: "unsafe", executionMode: "sequential" })),
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
		this.registry.install({
			...extension,
			tools: extension.tools?.map((tool) => ({ ...tool, replay: "unsafe", executionMode: "sequential" })),
		});
	}

	/** Serialize admission and stop, including the gap between root and child commits. */
	private ordered<T>(operation: () => Promise<T>): Promise<T> {
		const next = this.operations.then(operation);
		this.operations = next.catch(() => undefined);
		return next;
	}

	private handle(id: TaskId<WorkerAnswer>): ReporterHandle {
		let handle = this.handles.get(id);
		if (!handle) {
			handle = {
				id,
				wait: async () => {
					const { outcome } = (await this.harness.waitForTask(id, context)).state;
					if (outcome.status === "completed") return outcome.result;
					return outcome.status === "aborted"
						? { ok: false, aborted: true }
						: { ok: false, error: `Reporter ${outcome.status}` };
				},
			};
			this.handles.set(id, handle);
		}
		return handle;
	}

	/** Durable admission, not answer completion. Duplicate IDs return the same Reporter. */
	admit(requestId: string, content: string, followUp = false): Promise<ReporterHandle> {
		return this.ordered(async () => {
			if (this.closing || this.cancelled) throw new Error("Conversation runtime is stopped");
			const id = await this.root.commit(async (tx) => {
				const state = await tx.doc(RuntimeDoc, this.root.id);
				const key = requestKey(requestId);
				if (Object.hasOwn(state.requests, key)) {
					const existing = state.requests[key]!;
					if (existing.content !== content || existing.followUp !== followUp)
						throw new Error(`Request ID reused with different content or mode: ${requestId}`);
					return existing.reporterId;
				}
				const reporterId = await tx.createTask(
					Reporter,
					{ requestId, conversationId: this.child.id, content, followUp },
					background,
				);
				state.requests[key] = { reporterId, content, followUp };
				return reporterId;
			}, context);
			// Place input before acknowledging admission or admitting a later stop. Reporter
			// deliver uses the identical draft; request-ID dedup covers either delivery race.
			const task = await this.harness.getTask(id, context);
			if (task?.state.status !== "terminal" && !task?.abortRequested)
				await this.child.submit(
					{ type: "input", requestId, content, whenBusy: followUp ? "followUp" : "steer" },
					context,
				);
			return this.handle(id);
		});
	}

	async run(requestId: string, content: string, followUp = false): Promise<WorkerAnswer> {
		return (await this.admit(requestId, content, followUp)).wait();
	}

	/** Reattach receipts, including terminal receipts whose IPC may have been lost. */
	async reporters(): Promise<Array<{ requestId: string; handle: ReporterHandle }>> {
		const state = await this.harness.snapshot(RuntimeDoc, this.root.id, context);
		return Object.entries(state?.requests ?? {}).map(([key, admission]) => ({
			requestId: key.slice("request:".length),
			handle: this.handle(admission.reporterId),
		}));
	}

	async status(): Promise<WorkerStatus> {
		return this.root.commit(async (tx) => {
			const state = await tx.doc(RuntimeDoc, this.root.id);
			const live = await tx.doc(LiveDoc, this.child.id);
			const inbox = await tx.doc(InboxDoc, this.child.id);
			let working = !!live.run || inbox.items.length > 0;
			let last: { id: EntryId; text: string } | undefined;
			for (const [key, admission] of Object.entries(state.requests)) {
				const reporter = await tx.task(admission.reporterId);
				working ||= reporter?.state.status !== "terminal";
				const submission = await tx.submissionByRequest(this.child.id, key.slice("request:".length));
				if (submission?.status !== "done" || submission.type !== "input") continue;
				if (last && last.id >= submission.answer) continue;
				const message = (await tx.entry(AssistantEntry, submission.answer))?.model?.[0];
				if (message?.role === "assistant")
					last = {
						id: submission.answer,
						text: message.content
							.flatMap((p) => (p.type === "text" ? [p.text] : []))
							.join("")
							.trim(),
					};
			}
			return {
				conversationId: String(this.child.id),
				working,
				...(last ? { lastAnswer: { id: String(last.id), text: last.text } } : {}),
			};
		}, context);
	}

	/** Stop crosses background boundaries, but never retires the child. */
	stop(): Promise<void> {
		return this.ordered(async () => {
			if (this.closing) throw new Error("Conversation runtime is closed");
			// Abort and join Reporters first. None can redeliver after child.abort withdraws inputs.
			await this.root.abort(context, { background: true });
			await this.child.abort(context, { background: true });
		});
	}

	/** Cancel retires this worker runtime; pause/close deliberately do not abort. */
	cancel(): Promise<void> {
		this.cancelled = true;
		return (this.cancelling ??= this.stop());
	}

	close(): Promise<void> {
		return (this.closing ??= this.harness.close(context));
	}
}
