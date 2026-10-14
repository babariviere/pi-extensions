import assert from "node:assert/strict";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { SANDBOX_WRAP_COMMAND_EVENT, type WrapCommandRequest } from "../sandbox/service.ts";
import { testHost, withParentSession } from "../subagents/test-host.ts";
import jobs from "./index.ts";
import { jobsDirectory } from "./job-owners.ts";
import { JobsStorage } from "./job-storage.ts";
import type { JobSnapshot } from "./jobs-provider.ts";

const fast = { quietMs: 50, batchWindowMs: -1, batchMaxDelayMs: 0, maxDelayMs: 1_000 };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function sandboxHost() {
	const host = testHost();
	host.api.events.on(SANDBOX_WRAP_COMMAND_EVENT, (payload) => {
		const request = payload as WrapCommandRequest;
		request.result = Promise.resolve(request.command);
	});
	jobs(host.api, fast);
	return host;
}

async function snapshots(host: ReturnType<typeof testHost>): Promise<JobSnapshot[]> {
	return (await host.execute("jobs", { action: "list" })).structuredContent as unknown as JobSnapshot[];
}

async function eventually(check: () => Promise<boolean> | boolean, message: string): Promise<void> {
	const deadline = Date.now() + 3_000;
	while (Date.now() < deadline) {
		if (await check()) return;
		await sleep(10);
	}
	assert.fail(message);
}

test("jobs are native codemode tools with sandbox service wrapping and shutdown cleanup", async () => {
	await withParentSession(async () => {
		const host = testHost();
		let wrapped = 0;
		host.api.events.on(SANDBOX_WRAP_COMMAND_EVENT, (payload) => {
			const request = payload as WrapCommandRequest;
			wrapped++;
			request.result = Promise.resolve(request.command);
		});
		jobs(host.api);
		assert.equal(host.tools.size, 0);
		await host.emit("session_start");
		assert.deepEqual([...host.tools.keys()].sort(), ["jobs"]);
		for (const tool of host.tools.values()) {
			assert.equal(tool.exposure, "codemode");
			assert.deepEqual(tool.annotations, {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: false,
				openWorldHint: true,
			});
			assert.ok(tool.outputSchema);
			assert.match(tool.namespace?.instructions ?? "", /Unclaimed completions are grouped while idle/);
		}
		const started = (await host.execute("jobs", { action: "start", name: "child", command: "sleep 30" }))
			.structuredContent as { id: string };
		assert.deepEqual(
			(await host.execute("jobs", { action: "list" })).structuredContent,
			(await host.execute("jobs", { action: "status" })).structuredContent,
		);
		assert.equal(wrapped, 1);
		const previousFile = host.ctx.sessionManager.getSessionFile()!;
		host.ctx.sessionManager.getSessionId = () => "new-session";
		host.ctx.sessionManager.getSessionFile = () => join(dirname(previousFile), "new-session.jsonl");
		await host.emit("session_start", { reason: "new" });
		assert.deepEqual((await host.execute("jobs", { action: "status" })).structuredContent, []);
		assert.deepEqual((await host.execute("jobs", { action: "list" })).structuredContent, []);
		await assert.rejects(host.execute("jobs", { action: "wait", id: started.id }), /Unknown job:.*list/);
		assert.deepEqual(host.sent, []);
		await host.emit("session_shutdown");
		assert.ok([...host.tools.values()].every((tool) => tool.exposure === "hidden"));
	});
});

test("jobs fail closed when the standalone sandbox service is absent", async () => {
	await withParentSession(async () => {
		const host = testHost();
		jobs(host.api);
		await host.emit("session_start");
		await assert.rejects(
			host.execute("jobs", { action: "start", name: "blocked", command: "echo unsafe" }),
			/require the sandbox extension/,
		);
		assert.deepEqual((await host.execute("jobs", { action: "status" })).structuredContent, []);
		await host.emit("session_shutdown");
	});
});

test("a cancelled native wait leaves completion available for the idle follow-up", { timeout: 5_000 }, async () => {
	await withParentSession(async () => {
		const host = testHost();
		host.api.events.on(SANDBOX_WRAP_COMMAND_EVENT, (payload) => {
			const request = payload as WrapCommandRequest;
			request.result = Promise.resolve(request.command);
		});
		jobs(host.api, fast);
		await host.emit("session_start");
		try {
			host.setIdle(false);
			const started = (
				await host.execute("jobs", { action: "start", name: "survives", command: "sleep 0.1; echo ready" })
			).structuredContent as { id: string };
			const controller = new AbortController();
			const waiting = host.tools
				.get("jobs")!
				.execute(
					"wait-call",
					{ action: "wait", id: started.id, waitMs: 120_000 },
					controller.signal,
					undefined,
					host.ctx as never,
				);
			controller.abort(new Error("cancel wait"));
			assert.equal(((await waiting).structuredContent as { state: string }).state, "running");
			await eventually(async () => (await snapshots(host))[0]?.state === "done", "cancelled wait job completion");
			assert.equal(host.sent.length, 0);
			host.setIdle(true);
			await host.emit("agent_settled");
			await eventually(() => host.sent.length === 1, "cancelled wait completion follow-up");
			assert.equal(host.sent.length, 1);
			assert.equal(host.sent[0]?.message.details.jobs[0]?.id, started.id);
			assert.equal(host.sent[0]?.message.details.jobs[0]?.state, "done");
		} finally {
			await host.emit("session_shutdown");
		}
	});
});

test("unclaimed job completions trigger one grouped follow-up after the parent settles", async () => {
	await withParentSession(async () => {
		const host = testHost();
		host.api.events.on(SANDBOX_WRAP_COMMAND_EVENT, (payload) => {
			const request = payload as WrapCommandRequest;
			request.result = Promise.resolve(request.command);
		});
		jobs(host.api, fast);
		await host.emit("session_start");
		host.setIdle(false);
		const done = (await host.execute("jobs", { action: "start", name: "done", command: "echo done" }))
			.structuredContent as { id: string; outputPath: string };
		const failed = (await host.execute("jobs", { action: "start", name: "failed", command: "exit 7" }))
			.structuredContent as { id: string; outputPath: string };
		await new Promise((resolve) => setTimeout(resolve, 350));
		assert.equal(host.sent.length, 0);
		host.setIdle(true);
		await host.emit("agent_settled");
		await host.emit("agent_settled");
		assert.equal(host.sent.length, 0, "settling restarts the grouping window");
		await sleep(250);
		assert.equal(host.sent.length, 1);
		assert.equal(host.sent[0]?.message.customType, "jobs.result");
		assert.deepEqual(
			host.sent[0]?.message.details.jobs.map((job: { id: string }) => job.id),
			[done.id, failed.id],
		);
		const content = host.sent[0]?.message.content as string;
		assert.ok(content.includes(`done (${done.id}): done, exit code 0. Output: ${done.outputPath}`));
		assert.ok(content.includes(`failed (${failed.id}): failed, exit code 7. Output: ${failed.outputPath}`));
		assert.match(content, /Use read or bash with rg\/tail on the output paths/);
		assert.doesNotMatch(content, /action: "logs"/);
		assert.deepEqual(host.sent[0]?.options, { deliverAs: "followUp", triggerTurn: true });
		await host.emit("session_shutdown");
	});
});

test("terminal jobs wait suppresses the follow-up when the parent settles", async () => {
	await withParentSession(async () => {
		const host = testHost();
		host.api.events.on(SANDBOX_WRAP_COMMAND_EVENT, (payload) => {
			const request = payload as WrapCommandRequest;
			request.result = Promise.resolve(request.command);
		});
		jobs(host.api, fast);
		await host.emit("session_start");
		try {
			host.setIdle(false);
			const started = (await host.execute("jobs", { action: "start", name: "read", command: "echo already-read" }))
				.structuredContent as { id: string };
			const deadline = Date.now() + 3_000;
			let state: string | undefined;
			do {
				const statuses = (await host.execute("jobs", { action: "status" })).structuredContent as Array<{
					state: string;
				}>;
				state = statuses[0]?.state;
				if (state !== "running") break;
				await new Promise((resolve) => setTimeout(resolve, 10));
			} while (Date.now() < deadline);
			assert.equal(state, "done");
			const result = (await host.execute("jobs", { action: "wait", id: started.id })).structuredContent as {
				state: string;
				outputPath: string;
			};
			assert.equal(result.state, "done");
			assert.match(await readFile(result.outputPath, "utf8"), /already-read/);
			host.setIdle(true);
			await host.emit("agent_settled");
			await new Promise((resolve) => setTimeout(resolve, 250));
			await host.emit("agent_settled");
			assert.deepEqual(host.sent, []);
		} finally {
			await host.emit("session_shutdown");
		}
	});
});

test("reload reattaches running durable jobs without replacing their handles, logs, or lifetime timer", async (t) => {
	await withParentSession(async () => {
		const old = sandboxHost();
		const incoming = sandboxHost();
		const timers = t.mock.method(globalThis, "setTimeout");
		const cleared = t.mock.method(globalThis, "clearTimeout");
		await old.emit("session_start");
		try {
			const started = (
				await old.execute("jobs", {
					action: "start",
					name: "reload",
					command: "echo before; sleep 0.5; echo after",
				})
			).structuredContent as unknown as JobSnapshot;
			const directory = jobsDirectory({
				cwd: old.ctx.cwd,
				sessionId: old.ctx.sessionManager.getSessionId(),
				sessionFile: old.ctx.sessionManager.getSessionFile(),
			})!;
			assert.equal(started.outputPath, join(await realpath(directory), "logs", `${started.id}.log`));
			const lifetime = timers.mock.calls.filter((call) => call.arguments[1] === 2 * 60 * 60_000);
			assert.equal(lifetime.length, 1);
			const oldTool = old.tools.get("jobs")!;
			await eventually(
				async () => (await readFile(started.outputPath, "utf8")).includes("before"),
				"initial output",
			);
			await old.emit("session_shutdown", { reason: "reload" });
			assert.equal(old.tools.get("jobs")?.exposure, "hidden");
			await assert.rejects(
				async () => oldTool.execute("stale", { action: "list" }, undefined, undefined, old.ctx as never),
				/detached/,
			);
			await sleep(75);
			assert.deepEqual(old.sent, []);
			assert.equal(
				cleared.mock.calls.some((call) => call.arguments[0] === lifetime[0]?.result),
				false,
			);
			await incoming.emit("session_start", { reason: "reload" });
			assert.deepEqual(await snapshots(incoming), [started]);
			assert.equal(timers.mock.calls.filter((call) => call.arguments[1] === 2 * 60 * 60_000).length, 1);
			await eventually(() => incoming.sent.length === 1, "reattached completion");
			assert.equal(incoming.sent[0]?.message.details.jobs[0]?.id, started.id);
			assert.equal(incoming.sent[0]?.message.details.jobs[0]?.state, "done");
			assert.equal(await readFile(started.outputPath, "utf8"), "before\nafter\n");
			assert.equal(
				cleared.mock.calls.some((call) => call.arguments[0] === lifetime[0]?.result),
				true,
			);
			await incoming.emit("agent_settled");
			await sleep(150);
			assert.equal(incoming.sent.length, 1);
			assert.deepEqual(old.sent, []);
		} finally {
			await incoming.emit("session_shutdown", { reason: "quit" });
			// Reattach if startup failed, so a detached owner is still cleaned up.
			await old.emit("session_start", { reason: "reload" });
			await old.emit("session_shutdown", { reason: "quit" });
		}
	});
});

test("quit cancels running jobs while preserving durable records and logs without rerunning on restart", async () => {
	await withParentSession(async () => {
		const old = sandboxHost();
		const restarted = sandboxHost();
		let launches = 0;
		for (const host of [old, restarted]) host.api.events.on(SANDBOX_WRAP_COMMAND_EVENT, () => launches++);
		await old.emit("session_start");
		try {
			const started = (
				await old.execute("jobs", {
					action: "start",
					name: "quit",
					command: "echo launched; sleep 30; echo finished",
				})
			).structuredContent as unknown as JobSnapshot;
			await eventually(
				async () => (await readFile(started.outputPath, "utf8")).includes("launched"),
				"initial output",
			);
			await old.emit("session_shutdown", { reason: "quit" });
			assert.equal(await readFile(started.outputPath, "utf8"), "launched\n");
			assert.ok((await stat(join(dirname(dirname(started.outputPath)), "jobs.sqlite"))).isFile());
			await restarted.emit("session_start");
			const [recovered] = await snapshots(restarted);
			assert.equal(recovered?.id, started.id);
			assert.equal(recovered?.outputPath, started.outputPath);
			assert.equal(recovered?.startedAt, started.startedAt);
			assert.equal(recovered?.state, "cancelled");
			assert.ok(recovered?.endedAt);
			await restarted.emit("agent_settled");
			await sleep(150);
			assert.deepEqual(old.sent, []);
			assert.equal(restarted.sent.length, 0);
			assert.equal(launches, 1);
			assert.equal(await readFile(started.outputPath, "utf8"), "launched\n");
		} finally {
			await old.emit("session_shutdown", { reason: "quit" });
			await restarted.emit("session_shutdown", { reason: "quit" });
		}
	});
});

test("durable list and log reads do not claim completed jobs, which wake once after restart", async () => {
	await withParentSession(async () => {
		const old = sandboxHost();
		const restarted = sandboxHost();
		const again = sandboxHost();
		old.setIdle(false);
		restarted.setIdle(false);
		await old.emit("session_start");
		try {
			const started = (await old.execute("jobs", { action: "start", name: "pending", command: "echo durable" }))
				.structuredContent as unknown as JobSnapshot;
			await eventually(async () => (await snapshots(old))[0]?.state === "done", "completed job");
			const completed = await snapshots(old);
			assert.equal(await readFile(started.outputPath, "utf8"), "durable\n");
			await old.emit("session_shutdown", { reason: "quit" });
			await restarted.emit("session_start");
			assert.deepEqual(await snapshots(restarted), completed);
			assert.deepEqual((await restarted.execute("jobs", { action: "status" })).structuredContent, completed);
			assert.equal(await readFile(started.outputPath, "utf8"), "durable\n");
			await sleep(100);
			assert.equal(restarted.sent.length, 0);
			restarted.setIdle(true);
			await restarted.emit("agent_settled");
			await eventually(() => restarted.sent.length === 1, "recovered unclaimed completion");
			assert.deepEqual(restarted.sent[0]?.message.details.jobs, completed);
			await restarted.emit("agent_settled");
			await sleep(100);
			assert.equal(restarted.sent.length, 1);
			await restarted.emit("session_shutdown", { reason: "quit" });
			await again.emit("session_start");
			assert.deepEqual(await snapshots(again), completed);
			await again.emit("agent_settled");
			await sleep(150);
			assert.deepEqual(again.sent, []);
			assert.deepEqual(old.sent, []);
		} finally {
			for (const host of [old, restarted, again]) await host.emit("session_shutdown", { reason: "quit" });
		}
	});
});

test("terminal wait claims persist and suppress completion notifications across restart", async () => {
	await withParentSession(async () => {
		const old = sandboxHost();
		const restarted = sandboxHost();
		old.setIdle(false);
		await old.emit("session_start");
		try {
			const started = (await old.execute("jobs", { action: "start", name: "claimed", command: "echo claimed" }))
				.structuredContent as unknown as JobSnapshot;
			const completed = (await old.execute("jobs", { action: "wait", id: started.id }))
				.structuredContent as unknown as JobSnapshot;
			assert.equal(completed.state, "done");
			await old.emit("session_shutdown", { reason: "quit" });
			await restarted.emit("session_start");
			assert.deepEqual(await snapshots(restarted), [completed]);
			assert.deepEqual(
				(await restarted.execute("jobs", { action: "wait", id: started.id })).structuredContent,
				completed,
			);
			await restarted.emit("agent_settled");
			await sleep(150);
			assert.deepEqual(old.sent, []);
			assert.equal(restarted.sent.length, 0);
			assert.equal(await readFile(completed.outputPath, "utf8"), "claimed\n");
		} finally {
			await old.emit("session_shutdown", { reason: "quit" });
			await restarted.emit("session_shutdown", { reason: "quit" });
		}
	});
});

test("in-memory jobs survive detached reload completion and remove temporary logs only on quit", async () => {
	await withParentSession(async () => {
		const old = sandboxHost();
		const incoming = sandboxHost();
		old.ctx.sessionManager.getSessionFile = () => undefined;
		incoming.ctx.sessionManager.getSessionFile = () => undefined;
		await old.emit("session_start");
		let outputPath: string | undefined;
		try {
			const started = (
				await old.execute("jobs", { action: "start", name: "memory", command: "sleep 0.5; echo survived" })
			).structuredContent as unknown as JobSnapshot;
			outputPath = started.outputPath;
			assert.equal(jobsDirectory({ cwd: old.ctx.cwd, sessionId: old.ctx.sessionManager.getSessionId() }), undefined);
			await old.emit("session_shutdown", { reason: "reload" });
			await eventually(
				async () => (await readFile(started.outputPath, "utf8").catch(() => "")).includes("survived"),
				"detached completion",
			);
			await sleep(150);
			assert.deepEqual(old.sent, []);
			await incoming.emit("session_start", { reason: "reload" });
			const [completed] = await snapshots(incoming);
			assert.equal(completed?.id, started.id);
			assert.equal(completed?.startedAt, started.startedAt);
			assert.equal(completed?.outputPath, started.outputPath);
			assert.equal(completed?.state, "done");
			await eventually(() => incoming.sent.length === 1, "in-memory recovered completion");
			await incoming.emit("agent_settled");
			await sleep(100);
			assert.equal(incoming.sent.length, 1);
			assert.deepEqual(old.sent, []);
		} finally {
			await incoming.emit("session_shutdown", { reason: "quit" });
			await old.emit("session_start", { reason: "reload" });
			await old.emit("session_shutdown", { reason: "quit" });
		}
		assert.ok(outputPath);
		await assert.rejects(stat(dirname(outputPath)), { code: "ENOENT" });
	});
});

test("switch and fork isolate incoming handles while retaining outgoing cancelled history", async () => {
	await withParentSession(async () => {
		for (const reason of ["resume", "fork"] as const) {
			const host = sandboxHost();
			const sessionFile = host.ctx.sessionManager.getSessionFile()!;
			const outgoingId = `${reason}-outgoing`;
			host.ctx.sessionManager.getSessionId = () => outgoingId;
			await host.emit("session_start");
			try {
				const started = (
					await host.execute("jobs", { action: "start", name: "outgoing", command: "echo outgoing; sleep 30" })
				).structuredContent as unknown as JobSnapshot;
				await eventually(
					async () => (await readFile(started.outputPath, "utf8")).includes("outgoing"),
					"outgoing output",
				);
				await host.emit("session_shutdown", { reason });
				host.ctx.sessionManager.getSessionId = () => `${reason}-incoming`;
				// A fork can share a file, but its new session ID must still isolate jobs.
				host.ctx.sessionManager.getSessionFile = () =>
					reason === "fork" ? sessionFile : join(dirname(sessionFile), "switched.jsonl");
				await host.emit("session_start", { reason });
				assert.deepEqual(await snapshots(host), []);
				await assert.rejects(host.execute("jobs", { action: "wait", id: started.id }), /Unknown job/);
				assert.equal(await readFile(started.outputPath, "utf8"), "outgoing\n");
				await host.emit("session_shutdown", { reason: "resume" });
				host.ctx.sessionManager.getSessionId = () => outgoingId;
				host.ctx.sessionManager.getSessionFile = () => sessionFile;
				await host.emit("session_start", { reason: "resume" });
				const [recovered] = await snapshots(host);
				assert.equal(recovered?.id, started.id);
				assert.equal(recovered?.outputPath, started.outputPath);
				assert.equal(recovered?.state, "cancelled");
				await host.emit("agent_settled");
				await sleep(100);
				assert.equal(host.sent.length, 0);
			} finally {
				await host.emit("session_shutdown", { reason: "quit" });
			}
		}
	});
});

test("quit supersedes a concurrent new-session startup without recreating a jobs owner", async () => {
	await withParentSession(async () => {
		const host = sandboxHost();
		await host.emit("session_start");
		try {
			const started = (await host.execute("jobs", { action: "start", name: "outgoing", command: "sleep 30" }))
				.structuredContent as unknown as JobSnapshot;
			const oldTool = host.tools.get("jobs")!;
			const oldDirectory = dirname(dirname(started.outputPath));
			const sessionFile = host.ctx.sessionManager.getSessionFile()!;
			host.ctx.sessionManager.getSessionId = () => "superseded-new-session";
			host.ctx.sessionManager.getSessionFile = () => join(dirname(sessionFile), "superseded.jsonl");
			const incomingDirectory = jobsDirectory({
				cwd: host.ctx.cwd,
				sessionId: host.ctx.sessionManager.getSessionId(),
				sessionFile: host.ctx.sessionManager.getSessionFile(),
			})!;
			const starting = host.emit("session_start", { reason: "new" });
			const stopping = host.emit("session_shutdown", { reason: "quit" });
			await Promise.all([starting, stopping]);
			assert.equal(host.tools.get("jobs")?.exposure, "hidden");
			await assert.rejects(host.execute("jobs", { action: "list" }), /Unavailable tool/);
			await assert.rejects(
				async () => oldTool.execute("stale", { action: "list" }, undefined, undefined, host.ctx as never),
				/detached/,
			);
			await assert.rejects(stat(incomingDirectory), { code: "ENOENT" });
			// An independent storage open proves that shutdown released the outgoing owner's lease.
			const storage = JobsStorage.open(oldDirectory);
			try {
				assert.equal(storage.load()[0]?.snapshot.state, "cancelled");
			} finally {
				storage.close();
			}
			assert.equal(host.sent.length, 0);
		} finally {
			await host.emit("session_shutdown", { reason: "quit" });
		}
	});
});

test("quit during first-ever startup leaves tools empty and does not acquire a jobs owner", async () => {
	await withParentSession(async () => {
		const host = sandboxHost();
		const directory = jobsDirectory({
			cwd: host.ctx.cwd,
			sessionId: host.ctx.sessionManager.getSessionId(),
			sessionFile: host.ctx.sessionManager.getSessionFile(),
		})!;
		try {
			const starting = host.emit("session_start", { reason: "startup" });
			const stopping = host.emit("session_shutdown", { reason: "quit" });
			await Promise.all([starting, stopping]);
			assert.equal(host.tools.size, 0);
			await assert.rejects(host.execute("jobs", { action: "list" }), /Unavailable tool/);
			await assert.rejects(stat(directory), { code: "ENOENT" });
			assert.equal(host.sent.length, 0);
		} finally {
			await host.emit("session_shutdown", { reason: "quit" });
		}
	});
});

test("children and background attempts never register jobs tools", async () => {
	await withParentSession(async () => {
		for (const marker of ["PI_CODE_MODE_SUBAGENT", "PI_BACKGROUND_AGENT_ATTEMPT"]) {
			process.env[marker] = "1";
			const host = testHost();
			jobs(host.api);
			await host.emit("session_start");
			assert.equal(host.tools.size, 0);
			await host.emit("session_shutdown");
			delete process.env[marker];
		}
	});
});
