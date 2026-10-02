import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runConversationBatch } from "./conversation-backend.ts";
import { builtinAgent } from "./discovery.ts";
import type { RunContext } from "./run.ts";
import { DURABLE_PAUSE_REASON } from "./recovery.ts";

test("isolated worker uses real Harness generation with native codemode, structured results and policy hooks", async () => {
	const directory = await mkdtemp(join(tmpdir(), "durable-native-worker-"));
	const old = { agentDir: process.env.PI_CODING_AGENT_DIR, offline: process.env.PI_OFFLINE };
	process.env.PI_CODING_AGENT_DIR = directory;
	process.env.PI_OFFLINE = "1";
	try {
		await writeFile(
			join(directory, "settings.json"),
			JSON.stringify({
				extensions: [fileURLToPath(new URL("./fixtures/offline-native.ts", import.meta.url))],
				defaultProvider: "faux",
				defaultModel: "faux-1",
				defaultTools: ["+codemode"],
				cacheWarming: "off",
			}),
		);
		const context: RunContext = {
			cwd: directory,
			sessionId: "parent",
			sessionFile: join(directory, "parent.jsonl"),
			runId: "offline",
			projectTrusted: false,
			timeoutMs: 20_000,
		};
		const [result] = await runConversationBatch(
			[{ agent: builtinAgent(), task: "exercise native tools", index: 0, overrides: { model: "faux/faux-1" } }],
			context,
		);
		assert.equal(result?.ok, true, result?.error ?? "Worker failed");
		assert.equal(result.backend, "durable");
		assert.match(result.output, /native hook/);
		assert.ok(result.conversationId);
		assert.ok(result.outputPath);
		assert.equal(await readFile(result.outputPath, "utf8"), result.output);
		// Repeating worker admission reopens the same answer. It must not re-run faux or tools.
		const [again] = await runConversationBatch(
			[{ agent: builtinAgent(), task: "exercise native tools", index: 0, overrides: { model: "faux/faux-1" } }],
			context,
		);
		assert.equal(again?.ok, true, again?.error ?? "Recovered worker failed");
		assert.equal(again.conversationId, result.conversationId);
		assert.equal(again.output, result.output);
	} finally {
		if (old.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = old.agentDir;
		if (old.offline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = old.offline;
		await rm(directory, { recursive: true, force: true });
	}
});

test("expired recovery cannot reset the lifetime or start a worker", async () => {
	const [result] = await runConversationBatch([{ agent: builtinAgent(), task: "expired", index: 0 }], {
		cwd: tmpdir(),
		sessionId: "expired",
		sessionFile: undefined,
		runId: "expired",
		timeoutMs: 100_000,
		deadlineAt: Date.now() - 1,
	});
	assert.equal(result?.ok, false);
	assert.equal(result?.failure, "timeout");
});

for (const [task, marker] of [
	["recover model", "model-started"],
	["recover unsafe", "effects"],
	["recover store", "store-saved"],
	["recover forced", "model-started"],
]) {
	test(`worker pause/reopen ${task} retains its admission without replaying native effects`, async () => {
		const directory = await mkdtemp(join(tmpdir(), "durable-worker-reopen-"));
		const previous = { agentDir: process.env.PI_CODING_AGENT_DIR, offline: process.env.PI_OFFLINE };
		process.env.PI_CODING_AGENT_DIR = directory;
		process.env.PI_OFFLINE = "1";
		try {
			await writeFile(
				join(directory, "settings.json"),
				JSON.stringify({
					extensions: [fileURLToPath(new URL("./fixtures/offline-native.ts", import.meta.url))],
					defaultProvider: "faux",
					defaultModel: "faux-1",
					defaultTools: ["+codemode"],
					cacheWarming: "off",
				}),
			);
			const controller = new AbortController();
			const context: RunContext = {
				cwd: directory,
				sessionId: "parent",
				sessionFile: join(directory, "parent.jsonl"),
				runId: "resume",
				timeoutMs: 20_000,
				deadlineAt: Date.now() + 20_000,
			};
			const requests = [{ agent: builtinAgent(), task, index: 0, overrides: { model: "faux/faux-1" } }];
			const first = runConversationBatch(requests, { ...context, signal: controller.signal });
			const paused = assert.rejects(first, new RegExp(DURABLE_PAUSE_REASON));
			let started = false;
			for (let n = 0; n < 200 && !started; n++) {
				try {
					await access(join(directory, marker));
					started = true;
				} catch {
					await new Promise((resolve) => setTimeout(resolve, 25));
				}
			}
			assert.equal(started, true, "native worker did not start");
			controller.abort(DURABLE_PAUSE_REASON);
			await paused;
			const [resumed] = await runConversationBatch(requests, context);
			assert.equal(resumed?.ok, true, resumed?.error ?? "Recovery failed");
			if (task === "recover model" || task === "recover forced") assert.match(resumed.output, /user inputs: 1/);
			else if (task === "recover store") assert.match(resumed.output, /persisted-value/);
			else {
				assert.match(resumed.output, /not replayed/);
				assert.match(resumed.output, /interrupt/i);
				assert.equal(await readFile(join(directory, "effects"), "utf8"), "1");
			}
			if (task === "recover forced") assert.equal(await readFile(join(directory, "prompt-starts"), "utf8"), "1");
		} finally {
			if (previous.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous.agentDir;
			if (previous.offline === undefined) delete process.env.PI_OFFLINE;
			else process.env.PI_OFFLINE = previous.offline;
			await rm(directory, { recursive: true, force: true });
		}
	});
}
