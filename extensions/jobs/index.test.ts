import assert from "node:assert/strict";
import { test } from "node:test";
import { SANDBOX_WRAP_COMMAND_EVENT, type WrapCommandRequest } from "../sandbox/service.ts";
import { testHost, withParentSession } from "../subagents/test-host.ts";
import jobs from "./index.ts";

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
			assert.match(tool.namespace?.instructions ?? "", /tools\.jobs\(/);
		}
		await host.execute("jobs", { action: "start", name: "child", command: "sleep 30" });
		assert.equal(wrapped, 1);
		await host.emit("session_start", { reason: "new" });
		assert.deepEqual((await host.execute("jobs", { action: "status" })).structuredContent, []);
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

test("unclaimed job completions trigger one grouped follow-up only after the parent settles", async () => {
	await withParentSession(async () => {
		const host = testHost();
		host.api.events.on(SANDBOX_WRAP_COMMAND_EVENT, (payload) => {
			const request = payload as WrapCommandRequest;
			request.result = Promise.resolve(request.command);
		});
		jobs(host.api);
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
		assert.equal(host.sent.length, 1);
		assert.equal(host.sent[0]?.message.customType, "jobs.result");
		assert.deepEqual(
			host.sent[0]?.message.details.jobs.map((job: { id: string }) => job.id),
			[done.id, failed.id],
		);
		const content = host.sent[0]?.message.content as string;
		assert.ok(content.includes(`done (${done.id}): done, exit code 0. Output: ${done.outputPath}`));
		assert.ok(content.includes(`failed (${failed.id}): failed, exit code 7. Output: ${failed.outputPath}`));
		assert.deepEqual(host.sent[0]?.options, { deliverAs: "followUp", triggerTurn: true });
		await host.emit("session_shutdown");
	});
});

test("terminal jobs logs suppress the follow-up when the parent settles", async () => {
	await withParentSession(async () => {
		const host = testHost();
		host.api.events.on(SANDBOX_WRAP_COMMAND_EVENT, (payload) => {
			const request = payload as WrapCommandRequest;
			request.result = Promise.resolve(request.command);
		});
		jobs(host.api);
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
			const result = (await host.execute("jobs", { action: "logs", id: started.id })).structuredContent as {
				state: string;
				text: string;
			};
			assert.equal(result.state, "done");
			assert.match(result.text, /already-read/);
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
