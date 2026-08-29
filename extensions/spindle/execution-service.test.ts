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

test("workflow phases surface in the result", async () => {
	const service = serviceWith([]);
	const result = await execute(service, "await workflow.phase('scanning'); return 1;");
	assert.equal(result.success, true);
	assert.deepEqual(result.phases, ["scanning"]);
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
