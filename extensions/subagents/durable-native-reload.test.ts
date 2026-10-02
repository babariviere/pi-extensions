/** Exercise the real Pi extension loader and /reload lifecycle without any model requests. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
	type ExtensionContext,
	type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { acquireDurableSupervisor, closeDurableSupervisor } from "./durable-supervisor.ts";
import type { AgentResult } from "./agent-run-book.ts";
import { withParentSession } from "./test-host.ts";

test("real Pi reload reacquires the same durable supervisor through a freshly loaded extension", async () => {
	await withParentSession(async () => {
		const root = process.env.PI_CODING_AGENT_DIR!;
		const beforeOffline = process.env.PI_OFFLINE;
		process.env.PI_OFFLINE = "1";
		const manager = SessionManager.create(root, join(root, "sessions"));
		const ref = { cwd: root, sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile() };
		let captured: ExtensionContext | undefined;
		const errors: unknown[] = [];
		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir: root,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			additionalExtensionPaths: [fileURLToPath(new URL("./index.ts", import.meta.url))],
			extensionFactories: [
				(pi) => {
					pi.registerCommand("durable-capture", {
						description: "Capture the native test context",
						handler: async (_args, ctx) => {
							captured = ctx;
						},
					});
				},
			],
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		const { session } = await createAgentSession({
			cwd: root,
			agentDir: root,
			resourceLoader: loader,
			sessionManager: manager,
			settingsManager: SettingsManager.inMemory({ cacheWarming: "off" }),
			noTools: "builtin",
		});
		try {
			await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
			await session.prompt("/durable-capture");
			assert.ok(captured);
			const supervisor = await acquireDurableSupervisor(ref, async () => {
				throw new Error("No child may launch in this test");
			});
			let finish!: (results: AgentResult[]) => void;
			let cancelled = false;
			let detached = false;
			await supervisor.book.register({
				runId: "native-reload",
				agents: ["task"],
				promise: new Promise((resolve) => {
					finish = resolve;
				}),
				cancel: () => {
					cancelled = true;
					finish([]);
				},
				onDetach: () => {
					detached = true;
				},
			});
			const oldContext = captured;
			const oldWait = session.getToolDefinition("agents_wait");
			assert.ok(oldWait);
			let entered!: () => void;
			const ready = new Promise<void>((resolve) => {
				entered = resolve;
			});
			const originalWait = supervisor.book.wait.bind(supervisor.book);
			supervisor.book.wait = (runId, waitMs) => {
				const waiting = originalWait(runId, waitMs);
				entered();
				return waiting;
			};
			const obsoleteWait = oldWait.execute(
				"obsolete-wait",
				{ runId: "native-reload", waitMs: 60_000 },
				undefined,
				undefined,
				captured! as ExtensionToolContext,
			);
			await ready;
			supervisor.book.wait = originalWait;
			await session.reload();
			assert.equal(((await obsoleteWait).structuredContent as { state: string }).state, "running");
			await session.prompt("/durable-capture");
			assert.notEqual(captured, oldContext);
			assert.equal(cancelled, false);
			assert.equal(detached, true);
			const status = session.getToolDefinition("agents_status");
			assert.ok(status);
			const result = await status.execute("status", {}, undefined, undefined, captured! as ExtensionToolContext);
			assert.equal((result.structuredContent as Array<{ runId: string }>)[0]?.runId, "native-reload");
			const wait = session.getToolDefinition("agents_wait");
			assert.ok(wait);
			const waiting = wait.execute(
				"wait",
				{ runId: "native-reload", waitMs: 1_000 },
				undefined,
				undefined,
				captured! as ExtensionToolContext,
			);
			finish([{ agent: "task", ok: true, state: "done", runId: "native-reload", output: "completed" }]);
			const outcome = await waiting;
			assert.equal(
				(outcome.structuredContent as unknown as { results: AgentResult[] }).results[0]?.output,
				"completed",
			);
			assert.deepEqual(errors, []);
		} finally {
			await closeDurableSupervisor(ref);
			session.dispose();
			if (beforeOffline === undefined) delete process.env.PI_OFFLINE;
			else process.env.PI_OFFLINE = beforeOffline;
		}
	});
});
