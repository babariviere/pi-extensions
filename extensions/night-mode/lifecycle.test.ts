import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
	AgentBeforeSettleEvent,
	BoundaryResult,
	ExtensionAPI,
	ExtensionContext,
	SessionBoundaryDraft,
} from "@earendil-works/pi-coding-agent";
import nightMode from "./index.ts";
import { MIN_ELAPSED_BEFORE_STALL_MS } from "./night-mode.ts";
import { runIdFor } from "./ledger.ts";
import { readActiveNightRun } from "./night-run.ts";
import { USAGE_SNAPSHOT_EVENT } from "../usage/protocol.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;

interface HarnessOptions {
	entries?: Array<{ customType?: string; data?: unknown }>;
	beforeBoundary?: (event: AgentBeforeSettleEvent) => BoundaryResult | undefined;
	forceContextCanContinue?: boolean;
}

function createHarness(cwd: string, options: HarnessOptions = {}) {
	const handlers = new Map<string, Handler[]>();
	const listeners = new Map<string, Array<(value: unknown) => void>>();
	const messages: string[] = [];
	const notifications: string[] = [];
	const entries = options.entries ?? [];
	const model = { provider: "test", id: "night" };
	let command: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;

	if (options.beforeBoundary) {
		handlers.set("agent_before_settle", [
			((event: unknown) => options.beforeBoundary?.(event as AgentBeforeSettleEvent)) as Handler,
		]);
	}

	const pi = {
		on: (name: string, handler: Handler) => {
			const current = handlers.get(name) ?? [];
			current.push(handler);
			handlers.set(name, current);
		},
		events: {
			on: (name: string, handler: (value: unknown) => void) => {
				const current = listeners.get(name) ?? [];
				current.push(handler);
				listeners.set(name, current);
				return () =>
					listeners.set(
						name,
						(listeners.get(name) ?? []).filter((candidate) => candidate !== handler),
					);
			},
			emit: (name: string, value: unknown) => {
				for (const listener of listeners.get(name) ?? []) listener(value);
			},
		},
		registerTool() {},
		registerCommand: (_name: string, value: { handler: typeof command }) => {
			command = value.handler;
		},
		appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
		sendUserMessage: (message: string) => messages.push(message),
		setModel: async () => true,
	} as unknown as ExtensionAPI;

	const ctx = {
		cwd,
		model,
		mode: "tui",
		hasUI: true,
		isIdle: () => true,
		sessionManager: {
			getEntries: () => entries,
			getSessionId: () => "night-test-session",
			getSessionFile: () => join(cwd, "session.jsonl"),
		},
		modelRegistry: {
			find: (provider: string, id: string) => (provider === model.provider && id === model.id ? model : undefined),
			getAvailable: async () => [model],
		},
		ui: {
			notify: (message: string) => notifications.push(message),
			setStatus() {},
		},
	} as unknown as ExtensionContext;

	nightMode(pi);

	async function emit(name: string, event: unknown = {}): Promise<void> {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	}

	async function boundary(
		input: { outcome?: AgentBeforeSettleEvent["outcome"]; continue?: boolean; pendingMessages?: unknown[] } = {},
	): Promise<{ entries: SessionBoundaryDraft[]; continue: boolean }> {
		let boundaryEntries: SessionBoundaryDraft[] = [];
		let shouldContinue = input.continue ?? false;
		const pendingMessages = input.pendingMessages ?? [];
		for (const handler of handlers.get("agent_before_settle") ?? []) {
			const event = {
				type: "agent_before_settle",
				outcome: input.outcome ?? "completed",
				entries: boundaryEntries,
				continue: shouldContinue,
				context: {
					contextEntries: [],
					contextMessages: [],
					llmMessages: [{ role: "system" }, { role: "user" }, { role: "assistant" }],
					pendingMessages,
					canContinue:
						options.forceContextCanContinue ?? boundaryEntries.some((entry) => entry.type === "custom_message"),
				},
			} as unknown as AgentBeforeSettleEvent;
			const result = (await handler(event, ctx)) as BoundaryResult | undefined;
			if (result?.entries !== undefined) boundaryEntries = result.entries;
			if (result?.continue !== undefined) shouldContinue = result.continue;
		}
		return { entries: boundaryEntries, continue: shouldContinue };
	}

	return {
		boundary,
		command: async (args: string) => command?.(args, ctx),
		emit,
		emitUsage: (value: unknown) => pi.events.emit(USAGE_SNAPSHOT_EVENT, value),
		entries,
		handlers,
		messages,
		notifications,
		ctx,
	};
}

async function withProject<T>(
	options: HarnessOptions,
	fn: (harness: ReturnType<typeof createHarness>, cwd: string) => Promise<T>,
): Promise<T> {
	const cwd = mkdtempSync(join(tmpdir(), "night-lifecycle-"));
	const agentDir = join(cwd, "agent");
	const previousCwd = process.cwd();
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousTodoPath = process.env.PI_TODO_PATH;
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(cwd, "routine.md"), "Test routine", "utf-8");
	writeFileSync(
		join(cwd, ".pi", "settings.json"),
		JSON.stringify({
			nightMode: {
				orchestratorModel: "test/night",
				promptPath: join(cwd, "routine.md"),
				instructionsPath: join(cwd, "instructions.md"),
				reportPathTemplate: join(cwd, "reports", "{datetime}.md"),
				archiveDir: "",
				todoPath: join(cwd, "todos"),
				sandboxRoot: "",
				sandboxMode: "off",
				mcpReadOnly: false,
				wakeLock: "off",
			},
		}),
		"utf-8",
	);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.chdir(cwd);
	const harness = createHarness(cwd, options);
	try {
		return await fn(harness, cwd);
	} finally {
		await harness.emit("session_shutdown");
		process.chdir(previousCwd);
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousTodoPath === undefined) delete process.env.PI_TODO_PATH;
		else process.env.PI_TODO_PATH = previousTodoPath;
		rmSync(cwd, { recursive: true, force: true });
	}
}

function seedLedger(cwd: string): void {
	const active = readActiveNightRun()!;
	writeFileSync(
		join(cwd, "todos", "abc.md"),
		JSON.stringify({
			id: "abc",
			title: "Inspect the repository",
			status: "open",
			tags: ["night", `run:${runIdFor(new Date(active.startedAt))}`],
		}) + "\n\nCheck repository",
	);
}

test("a direct run with no ledger gets a run-tagged creation reminder at the boundary", async () => {
	await withProject({}, async (harness) => {
		await harness.command("start");
		const active = readActiveNightRun()!;
		const result = await harness.boundary();
		assert.equal(result.continue, true);
		const reminder = result.entries.at(-1) as { content: string };
		assert.match(reminder.content, /night ledger is empty/);
		assert.ok(reminder.content.includes(`run:${runIdFor(new Date(active.startedAt))}`));
		assert.equal(harness.messages.length, 1, "the reminder is a boundary entry, not a new user turn");
	});
});

test("ledger continuation chains boundary entries and ends a no-progress run at settlement", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: new Date(2026, 7, 29, 22).getTime() });
	const externalEntry: SessionBoundaryDraft = { type: "custom", customType: "other-extension", data: { kept: true } };
	await withProject(
		{
			entries: [],
			beforeBoundary: (event) => ({ entries: [...event.entries, externalEntry] }),
		},
		async (harness, cwd) => {
			await harness.emit("session_start");
			await harness.command("start");
			seedLedger(cwd);
			const first = await harness.boundary();
			assert.equal(first.continue, true);
			assert.equal(first.entries[0], externalEntry, "earlier handlers' proposed entries survive");
			const prompt = first.entries.find((candidate) => candidate.type === "custom_message") as
				| { content: string }
				| undefined;
			assert.ok(prompt);
			assert.match(prompt.content, /Inspect the repository/);
			assert.doesNotMatch(harness.messages.at(-1) ?? "", /Automated continuation/);

			t.mock.timers.tick(MIN_ELAPSED_BEFORE_STALL_MS);
			const repeated = await harness.boundary();
			assert.equal(repeated.continue, false, "an unchanged ledger is stopped by the fingerprint brake");
			assert.ok(harness.notifications.every((message) => !message.includes("ended")));
			await harness.emit("agent_settled");
			assert.equal(readActiveNightRun(), undefined, "run cleanup remains at final settlement");
			assert.match(
				readFileSync(join(cwd, "reports", "2026-08-29 2200.md"), "utf-8"),
				/stopped: the last automated continuation changed nothing/,
			);
		},
	);
});

test("aborted, failed, queued, and already-continuing boundaries do not add a restart", async () => {
	await withProject({ entries: [] }, async (harness, cwd) => {
		await harness.emit("session_start");
		await harness.command("start");
		seedLedger(cwd);
		for (const outcome of ["aborted", "error"] as const) {
			const result = await harness.boundary({ outcome });
			assert.equal(result.continue, false);
			assert.equal(result.entries.length, 0);
			const messagesBeforeSettle = harness.messages.length;
			await harness.emit("agent_settled");
			assert.equal(harness.messages.length, messagesBeforeSettle, `${outcome} settlement does not enqueue a retry`);
		}
		const queued = await harness.boundary({ pendingMessages: [{}] });
		assert.equal(queued.continue, false);
		assert.equal(queued.entries.length, 0);
		const chaining = await harness.boundary({ continue: true });
		assert.equal(chaining.continue, true, "another handler's continuation is preserved");
		assert.equal(chaining.entries.length, 0, "night-mode does not duplicate another continuation");
		const successful = await harness.boundary();
		assert.equal(successful.continue, true);
		assert.match(String((successful.entries.at(-1) as { content: string }).content), /continuation 1\/10/);
	});
});

test("night-mode honors the projected canContinue guard and stops cache warming only for a paused run", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: new Date(2026, 7, 29, 22).getTime() });
	await withProject({ entries: [], forceContextCanContinue: false }, async (harness, cwd) => {
		await harness.emit("session_start");
		await harness.command("start");
		seedLedger(cwd);
		const result = await harness.boundary();
		assert.equal(result.entries.length, 1, "the proposed message is still stored in the boundary");
		assert.equal(result.continue, false, "a false projected canContinue blocks the restart");

		const decision = await harness.handlers.get("cache_warming_decision")?.[0]?.(
			{ type: "cache_warming_decision", action: "warm" },
			harness.ctx,
		);
		assert.deepEqual(decision, undefined, "ordinary active night work leaves Pi's warming decision alone");
		harness.emitUsage({
			fetchedAt: Date.now(),
			snapshot: {
				provider: "anthropic",
				windows: [
					{ label: "5h", usedPercent: 99, resetsAt: new Date(Date.now() + 60 * 60_000).toISOString() },
					{ label: "Week", usedPercent: 1 },
				],
			},
		});
		const quotaPausedBoundary = await harness.boundary();
		assert.equal(quotaPausedBoundary.continue, false, "quota pause suppresses ledger continuations");
		const pausedDecision = await harness.handlers.get("cache_warming_decision")?.[0]?.(
			{ type: "cache_warming_decision", action: "warm" },
			harness.ctx,
		);
		assert.deepEqual(pausedDecision, { action: "stop" });
		await harness.command("resume");
		t.mock.timers.setTime(Date.now() + 11 * 60 * 60_000);
		const outsideScheduleBoundary = await harness.boundary();
		assert.equal(outsideScheduleBoundary.continue, false, "a closed schedule suppresses ledger continuations");
		const outsideScheduleDecision = await harness.handlers.get("cache_warming_decision")?.[0]?.(
			{ type: "cache_warming_decision", action: "warm" },
			harness.ctx,
		);
		assert.deepEqual(outsideScheduleDecision, { action: "stop" }, "a night run outside its window stops warming");
	});

	await withProject({}, async (harness) => {
		const decision = await harness.handlers.get("cache_warming_decision")?.[0]?.(
			{ type: "cache_warming_decision", action: "warm" },
			harness.ctx,
		);
		assert.equal(decision, undefined, "ordinary sessions keep Pi's default cache warming behavior");
	});
});
