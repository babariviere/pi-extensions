import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { DurableSupervisor, SubagentReport } from "./durable-supervisor.ts";
import subagents, { SubagentParameters } from "./index.ts";
import { testHost, withParentSession } from "./test-host.ts";

function fakeOwner() {
	const calls: Array<{ action: string; args: any[] }> = [];
	const closes: Array<{ preserveRuns?: boolean } | undefined> = [];
	let sink: ((report: SubagentReport) => void) | undefined;
	let ready = () => true;
	let pending: SubagentReport | undefined;
	const status = { name: "review", state: "idle", conversationId: "8", lastAnswer: { id: "10", text: "completed" } };
	const record = (action: string, args: any[]) => {
		calls.push({ action, args });
		return status;
	};
	const owner = {
		setErrorHandler() {},
		setSink(fn: typeof sink, check?: () => boolean) {
			sink = fn;
			ready = check ?? (() => true);
		},
		subscribe: () => () => {},
		suspend: () => {
			sink = undefined;
		},
		list: () => [{ name: status.name, state: status.state, conversationId: status.conversationId }],
		status: async (...args: any[]) => record("status", args),
		spawn: async (...args: any[]) => record("spawn", args),
		send: async (...args: any[]) => record("send", args),
		stop: async (...args: any[]) => record("stop", args),
		flushReports: async () => {
			if (sink && pending && ready()) {
				const report = pending;
				pending = undefined;
				sink(report);
			}
		},
	};
	return {
		owner: owner as unknown as DurableSupervisor,
		calls,
		closes,
		report: (report: SubagentReport) => {
			pending = report;
		},
	};
}
async function setup(config?: object) {
	const host = testHost();
	const fake = fakeOwner();
	if (config) await writeFile(join(process.env.PI_CODING_AGENT_DIR!, "subagents.json"), JSON.stringify(config));
	const context = host.ctx as unknown as { model: { provider: string; id: string; api: string } };
	context.model = { provider: "test", id: "parent", api: "test" };
	subagents(host.api, {
		acquireDurableSupervisor: async () => fake.owner,
		closeDurableSupervisor: async (_ref, options) => {
			fake.closes.push(options);
		},
	});
	await host.emit("session_start");
	const definition = host.tools.get("subagent")!;
	const execute = (args: object, id = "call", signal?: AbortSignal) =>
		definition.execute(id, args, signal, undefined, host.ctx as never);
	return { host, fake, definition, execute };
}

test("only the upstream single tool schema is registered without legacy caller fields", async () => {
	await withParentSession(async () => {
		const { host, definition } = await setup();
		assert.deepEqual([...host.tools.keys()], ["subagent"]);
		assert.equal(definition.exposure, "codemode");
		assert.deepEqual(Object.keys(SubagentParameters.properties).sort(), ["action", "followUp", "message", "name"]);
		assert.deepEqual(SubagentParameters.required, ["action"]);
		assert.equal((SubagentParameters as unknown as { additionalProperties: boolean }).additionalProperties, false);
		assert.deepEqual(
			SubagentParameters.properties.action.anyOf.map((value) => value.const),
			["spawn", "send", "stop", "status"],
		);
		await host.emit("session_shutdown", { reason: "quit" });
	});
});

test("spawn pins host model/thinking/lifetime and send defaults to steer or queues explicitly", async () => {
	await withParentSession(async () => {
		const { host, fake, execute } = await setup({
			defaultModel: "test/default",
			defaultThinking: "low",
			timeoutMs: 3000,
		});
		await execute({ action: "spawn", name: " review ", message: "scope" }, "spawn");
		assert.equal(fake.calls[0]!.action, "spawn");
		assert.deepEqual(fake.calls[0]!.args.slice(0, 3), ["review", "scope", "spawn"]);
		assert.deepEqual(fake.calls[0]!.args[3], {
			model: "test/default",
			thinking: "low",
			parentProvider: "test",
			models: [],
			timeoutMs: 3000,
		});
		await execute({ action: "send", name: "review", message: "steer" }, "steer");
		await execute({ action: "send", name: "review", message: "next", followUp: true }, "next");
		assert.deepEqual(fake.calls[1]!.args, ["review", "steer", false, "steer"]);
		assert.deepEqual(fake.calls[2]!.args, ["review", "next", true, "next"]);
		await execute({ action: "stop", name: "review" });
		assert.equal(fake.calls.at(-1)!.action, "stop");
		await host.emit("session_shutdown", { reason: "quit" });
	});
});

test("without a host override spawn inherits the current physical parent model", async () => {
	await withParentSession(async () => {
		const { host, fake, execute } = await setup();
		await execute({ action: "spawn", name: "review", message: "work" });
		assert.equal(fake.calls[0]!.args[3].model, "test/parent");
		(host.ctx as unknown as { model: unknown }).model = { provider: "test", id: "new", api: "test" };
		await host.emit("before_agent_start");
		await execute({ action: "spawn", name: "second", message: "work" });
		assert.equal(fake.calls[1]!.args[3].model, "test/new");
		await host.emit("session_shutdown", { reason: "quit" });
	});
});

test("named status exposes lastAnswer but the all-agent overview is compact and non-destructive", async () => {
	await withParentSession(async () => {
		const { host, fake, execute } = await setup();
		const all = await execute({ action: "status" });
		assert.deepEqual(all.structuredContent, { agents: [{ name: "review", state: "idle", conversationId: "8" }] });
		const named = await execute({ action: "status", name: "review" });
		assert.deepEqual((named.details as any).lastAnswer, { id: "10", text: "completed" });
		assert.deepEqual(named.structuredContent, named.details);
		assert.equal(fake.calls.length, 1);
		await host.emit("session_shutdown", { reason: "quit" });
	});
});

test("notifications wait for parent idle and reload hides stale tool/context without cancelling work", async () => {
	await withParentSession(async () => {
		const { host, fake, execute } = await setup();
		const report: SubagentReport = { name: "review", conversationId: "8", answerId: "10", text: "complete" };
		host.setIdle(false);
		fake.report(report);
		await host.emit("agent_settled");
		assert.equal(host.sent.length, 0);
		host.setIdle(true);
		await host.emit("agent_settled");
		assert.equal(host.sent.length, 1);
		assert.equal(host.sent[0]!.message.customType, "subagent.result");
		assert.deepEqual(host.sent[0]!.options, { deliverAs: "followUp", triggerTurn: true });
		await host.emit("session_shutdown", { reason: "reload" });
		assert.equal(fake.closes.length, 0);
		assert.equal(host.tools.get("subagent")!.exposure, "hidden");
		await assert.rejects(execute({ action: "status" }), /not initialized/);
		fake.report(report);
		await fake.owner.flushReports();
		assert.equal(host.sent.length, 1);
		await host.emit("session_start");
		await host.emit("agent_settled");
		assert.equal(host.sent.length, 2);
		await host.emit("session_shutdown", { reason: "quit" });
		assert.deepEqual(fake.closes, [{ preserveRuns: true }]);
	});
});

test("invalid names/messages/actions and pre-aborted calls are rejected before admission", async () => {
	await withParentSession(async () => {
		const { host, fake, execute } = await setup();
		for (const name of [undefined, "", " ", "\u0000", "a".repeat(129)])
			await assert.rejects(execute({ action: "spawn", name, message: "work" }), /non-empty name/);
		await assert.rejects(execute({ action: "send", name: "review", message: " " }), /non-empty message/);
		await assert.rejects(execute({ action: "bogus", name: "review", message: "work" }), /Unknown/);
		await assert.rejects(
			execute(
				{ action: "spawn", name: "review", message: "work" },
				"abort",
				AbortSignal.abort(new Error("aborted")),
			),
			/aborted/,
		);
		assert.equal(fake.calls.length, 0);
		await host.emit("session_shutdown", { reason: "switch" });
		assert.deepEqual(fake.closes, [{ preserveRuns: false }]);
	});
});

test("spawn budget is scoped to enclosing native execution, without counting send/status/stop", async () => {
	await withParentSession(async () => {
		const { host } = await setup({ maxPerExecution: 1 });
		const event = { toolName: "subagent", input: { action: "spawn" }, toolCallId: "child", parentToolCallId: "root" };
		assert.deepEqual(await host.emit("tool_call", event), [undefined]);
		assert.equal((await host.emit("tool_call", { ...event, input: { action: "send" } }))[0], undefined);
		assert.equal(((await host.emit("tool_call", event)) as any[])[0].block, true);
		await host.emit("tool_execution_end", { toolCallId: "root" });
		assert.deepEqual(await host.emit("tool_call", event), [undefined]);
		await host.emit("session_shutdown", { reason: "quit" });
	});
});

test("child and background attempt sessions cannot register the subagent tool", async () => {
	await withParentSession(async () => {
		for (const key of ["PI_CODE_MODE_SUBAGENT", "PI_BACKGROUND_AGENT_ATTEMPT"]) {
			const old = process.env[key];
			process.env[key] = "1";
			try {
				const host = testHost();
				subagents(host.api);
				await host.emit("session_start");
				assert.equal(host.tools.has("subagent"), false);
			} finally {
				if (old === undefined) delete process.env[key];
				else process.env[key] = old;
			}
		}
	});
});
