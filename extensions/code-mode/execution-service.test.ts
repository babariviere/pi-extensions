import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_SPINDLE_CONFIG, type SpindleConfig } from "./config.ts";
import { ActionRegistry } from "./core/action-registry.ts";
import { SpindleExecutionService } from "./execution-service.ts";
import type { SpindleProvider } from "./protocol.ts";

/** A provider whose actions are plain functions over their arguments. */
const makeProvider = (
	name: string,
	actions: Record<string, (args: Record<string, unknown>) => unknown>,
): SpindleProvider => ({
	name,
	description: `${name} test provider`,
	list: async () =>
		Object.keys(actions).map((actionName) => ({
			name: actionName,
			description: `${name}.${actionName}`,
			inputSchema: {},
		})),
	describe: async (actionName) =>
		Object.hasOwn(actions, actionName)
			? {
					name: actionName,
					description: `${name}.${actionName}`,
					inputSchema: {},
				}
			: undefined,
	invoke: async (actionName, args) => actions[actionName]?.(args),
});

const configWith = (overrides: Partial<SpindleConfig> = {}): SpindleConfig =>
	structuredClone({
		...DEFAULT_SPINDLE_CONFIG,
		executor: {
			...DEFAULT_SPINDLE_CONFIG.executor,
			timeoutMs: 15_000,
			resultFormat: "json" as const,
		},
		agents: {
			...DEFAULT_SPINDLE_CONFIG.agents,
			maxPerExecution: 1,
			timeoutMs: 5_000,
		},
		...overrides,
	});

const serviceWith = (providers: SpindleProvider[], overrides: Partial<SpindleConfig> = {}): SpindleExecutionService => {
	const registry = new ActionRegistry();
	for (const provider of providers) registry.register(provider);
	return new SpindleExecutionService(registry, configWith(overrides));
};

const execute = (service: SpindleExecutionService, code: string, parentToolCallId = "test-call") =>
	service.execute({
		code,
		signal: undefined,
		parentToolCallId,
		context: { cwd: "/tmp" } as never,
		onPartial: () => {},
	});

test("type errors fail before execution and carry positions", async () => {
	const service = serviceWith([makeProvider("extensions", { echo: (args) => ({ echoed: args }) })]);
	const result = await execute(service, "return missing_identifier;");
	assert.equal(result.success, false);
	assert.equal(result.audits.length, 0);
	assert.equal(result.typeErrors?.length, 1);
	assert.equal(result.typeErrors![0]!.line, 1);
	assert.match(result.typeErrors![0]!.message, /missing_identifier/);
	// The trace carries the concrete failure, not the generic "Execution failed".
	assert.match(result.trace.error ?? "", /Type checking failed: L1:\d+ Cannot find name 'missing_identifier'/);
});

test("a program can call a registered extension tool", async () => {
	const service = serviceWith([makeProvider("extensions", { echo: (args) => ({ echoed: args }) })]);
	const result = await execute(service, "return await extensions.echo({ x: 1 });");
	assert.equal(result.success, true);
	assert.deepEqual(result.value, { echoed: { x: 1 } });
	assert.equal(result.audits.length, 1);
	assert.equal(result.audits[0]!.ref, "extensions.echo");
	assert.equal(result.audits[0]!.success, true);
	assert.ok(result.elapsedMs >= 0);
});

test("discovery actions dispatch through the static host calls", async () => {
	const service = serviceWith([makeProvider("extensions", { echo: (args) => ({ echoed: args }) })]);
	const result = await execute(
		service,
		[
			"const providers = await tools.providers();",
			"const listed = await tools.list({});",
			"const found = await tools.search({ query: 'echo' });",
			"const described = await tools.describe({ ref: 'extensions.echo' });",
			"const called = await tools.call({ ref: 'extensions.echo', args: { via: 'call' } });",
			"return {",
			"  providers: providers.map((provider) => provider.name),",
			"  listed: listed.length,",
			"  found: found.map((action) => action.ref),",
			"  described: described.name,",
			"  called,",
			"};",
		].join("\n"),
	);
	assert.equal(result.success, true, result.error ?? "");
	const value = result.value as {
		providers: string[];
		listed: number;
		found: string[];
		described: string;
		called: { echoed: Record<string, unknown> };
	};
	assert.deepEqual(value.providers, ["extensions"]);
	assert.equal(value.listed, 1);
	assert.deepEqual(value.found, ["extensions.echo"]);
	assert.equal(value.described, "echo");
	assert.deepEqual(value.called, { echoed: { via: "call" } });
});

test("discovery finds snake_case names through the extensions compatibility alias", async () => {
	const service = serviceWith([makeProvider("extensions", { web_search: () => ({}) })]);
	const result = await execute(
		service,
		"return (await extensions.tools.search({ query: 'web search' })).map((action) => action.ref);",
	);
	assert.equal(result.success, true, result.error ?? "");
	assert.deepEqual(result.value, ["extensions.web_search"]);
});

test("mapLimit bounds how many thunks run at once", async () => {
	const service = serviceWith([]);
	const result = await execute(
		service,
		[
			"let live = 0;",
			"let peak = 0;",
			"const out = await mapLimit([1, 2, 3, 4, 5, 6], async (n) => {",
			"  live++;",
			"  peak = Math.max(peak, live);",
			"  await new Promise((resolve) => setTimeout(resolve, 1));",
			"  live--;",
			"  return n * 2;",
			"}, 2);",
			"return { out, peak };",
		].join("\n"),
	);
	assert.equal(result.success, true, result.error ?? "");
	const value = result.value as { out: number[]; peak: number };
	assert.deepEqual(value.out, [2, 4, 6, 8, 10, 12]);
	assert.equal(value.peak, 2);
});

test("agent budget exhaustion fails the program", async () => {
	const service = serviceWith([
		makeProvider("agents", {
			list: () => [],
			run: () => ({ status: "completed", output: "ok" }),
			runAll: () => ({ status: "completed", output: "ok" }),
		}),
	]);
	const result = await execute(
		service,
		[
			"await agents.run({ agent: 'a', task: 't' });",
			"await agents.run({ agent: 'a', task: 't' });",
			"return 'done';",
		].join("\n"),
	);
	assert.equal(result.success, false);
	assert.match(result.error ?? "", /agent budget exhausted \(1 per execution\)/);
});

test("guest runtime errors map back to the program's lines", async () => {
	const service = serviceWith([]);
	const result = await execute(
		service,
		["const g = (): void => {", "  throw new Error('boom');", "};", "return g();"].join("\n"),
	);
	assert.equal(result.success, false);
	assert.equal(result.error !== undefined && /program\.ts:2:\d+/.test(result.error), true);
	assert.match(result.trace.error ?? "", /Error: boom/);
	assert.match(result.trace.error ?? "", /program\.ts:2:/);
});

test("print output reaches the result logs", async () => {
	const service = serviceWith([]);
	const result = await execute(service, "print('hello'); return 1;");
	assert.deepEqual(result.logs, ["hello"]);
});

test("a per-invocation timeout request raises the program deadline", async () => {
	const service = serviceWith([], { executor: { ...configWith().executor, timeoutMs: 1_000, maxTimeoutMs: 900_000 } });
	const sleep = "await new Promise((resolve) => setTimeout(resolve, 1_800)); return 'done';";

	const timedOut = await execute(service, sleep);
	assert.equal(timedOut.success, false);

	const raised = await service.execute({
		code: sleep,
		signal: undefined,
		parentToolCallId: "raised",
		context: { cwd: "/tmp" } as never,
		requestedTimeoutMs: 20_000,
		onPartial: () => {},
	});
	assert.equal(raised.success, true, raised.error ?? "");
	assert.equal(raised.value, "done");
});

test("a per-invocation timeout request never lowers the configured deadline", async () => {
	const service = serviceWith([], {
		executor: { ...configWith().executor, timeoutMs: 15_000, maxTimeoutMs: 900_000 },
	});
	const result = await service.execute({
		code: "await new Promise((resolve) => setTimeout(resolve, 1_200)); return 'done';",
		signal: undefined,
		parentToolCallId: "lowered",
		context: { cwd: "/tmp" } as never,
		requestedTimeoutMs: 10,
		onPartial: () => {},
	});
	assert.equal(result.success, true, result.error ?? "");
});

test("τ state survives between programs and is echoed on the result", async () => {
	const service = serviceWith([]);
	const first = await execute(service, "await τ.set('index', { files: ['a.ts'] }); return await τ.keys();");
	assert.equal(first.success, true, first.error ?? "");
	assert.deepEqual(
		(first.value as Array<{ key: string }>).map((entry) => entry.key),
		["index"],
	);
	// The discoverability half of the contract: the result names what is held.
	assert.deepEqual(
		(first.stateKeys ?? []).map((entry) => entry.key),
		["index"],
	);
	// Each operation is reported for its own row, with the value it moved.
	assert.deepEqual(
		(first.stateNotes ?? []).map((note) => note.ref),
		["spindle.state.set", "spindle.state.keys"],
	);
	assert.equal(first.stateNotes?.[0]?.key, "index");
	assert.match(first.stateNotes?.[0]?.preview ?? "", /"files":\["a\.ts"\]/);

	const second = await execute(service, "return await τ.get('index');", "test-call-2");
	assert.equal(second.success, true, second.error ?? "");
	assert.deepEqual(second.value, { files: ["a.ts"] });

	const third = await execute(service, "await τ.delete('index'); return await τ.get('index');", "test-call-3");
	assert.equal(third.success, true, third.error ?? "");
	assert.equal(third.value, undefined);
	// The store is empty again, so there are no keys to report, but the two
	// operations still are.
	assert.equal(third.stateKeys, undefined);
	assert.deepEqual(
		(third.stateNotes ?? []).map((note) => `${note.ref}:${note.detail ?? note.preview ?? ""}`),
		["spindle.state.delete:deleted", "spindle.state.get:not held"],
	);
});

test("a program that never touches τ is told nothing about it", async () => {
	const service = serviceWith([]);
	const seeded = await execute(service, "await τ.set('held', 1); return 'ok';");
	assert.equal(seeded.success, true, seeded.error ?? "");
	assert.equal(seeded.stateKeys?.length, 1);

	const untouched = await execute(service, "return 1 + 1;", "test-call-b");
	assert.equal(untouched.success, true, untouched.error ?? "");
	assert.equal(untouched.stateKeys, undefined);
	assert.equal(untouched.stateNotes, undefined);
});

test("a τ write that cannot be honored fails the call, not silently", async () => {
	const service = serviceWith([]);
	const result = await execute(
		service,
		[
			"const errors = [];",
			"try { await τ.set('bad key', 1); } catch (error) { errors.push(String(error.message)); }",
			"try { await τ.set('fn', () => 1); } catch (error) { errors.push(String(error.message)); }",
			"return { errors, keys: await τ.keys() };",
		].join("\n"),
	);
	assert.equal(result.success, true, result.error ?? "");
	const value = result.value as { errors: string[]; keys: unknown[] };
	assert.equal(value.errors.length, 2);
	assert.match(value.errors[0]!, /is not allowed/);
	assert.match(value.errors[1]!, /cannot store undefined or a function/);
	assert.deepEqual(value.keys, []);
});
