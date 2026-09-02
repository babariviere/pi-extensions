import assert from "node:assert/strict";
import { test } from "node:test";

import { QuickJsRuntime } from "./quickjs-runtime.ts";

const unexpectedHostCall = async () => {
	throw new Error("unexpected host call");
};

const baseOptions = {
	timeoutMs: 10_000,
	memoryLimitBytes: 64 * 1024 * 1024,
};

test("process exposes the injected allowlisted snapshot", async () => {
	const runtime = new QuickJsRuntime();
	const result = await runtime.execute(
		"return [process.env.HOME, process.platform, process.arch, process.cwd(), Object.isFrozen(process.env), Object.isFrozen(process)].join('|');",
		unexpectedHostCall,
		{
			timeoutMs: 10_000,
			memoryLimitBytes: 32 * 1024 * 1024,
			process: { env: { HOME: "/home/test" }, platform: "linux", arch: "x64", cwd: "/session" },
		},
	);
	assert.equal(result.terminationReason, "completed");
	assert.equal(result.value, "/home/test|linux|x64|/session|true|true");
});

test("process falls back to an empty shim when nothing is injected", async () => {
	const runtime = new QuickJsRuntime();
	const result = await runtime.execute(
		"return [JSON.stringify(process.env), process.platform, process.cwd()].join('|');",
		unexpectedHostCall,
		{ timeoutMs: 10_000, memoryLimitBytes: 32 * 1024 * 1024 },
	);
	assert.equal(result.terminationReason, "completed");
	assert.equal(result.value, "{}|unknown|");
});

test("host call results marshal into the guest", async () => {
	const runtime = new QuickJsRuntime();
	const result = await runtime.execute(
		"return await pi.read('/x');",
		async () => ({ a: 1, b: "two", c: [true, null], d: { nested: 3.5 } }),
		baseOptions,
	);
	assert.equal(result.terminationReason, "completed");
	assert.deepEqual(result.value, { a: 1, b: "two", c: [true, null], d: { nested: 3.5 } });
});

test("host call rejections reject the guest program", async () => {
	const runtime = new QuickJsRuntime();
	const result = await runtime.execute(
		"await pi.read('/x');",
		async () => {
			throw new Error("host exploded");
		},
		baseOptions,
	);
	assert.equal(result.terminationReason, "runtime_error");
	assert.match(result.error ?? "", /host exploded/);
});

test("concurrent host calls interleave correctly", async () => {
	const runtime = new QuickJsRuntime();
	const result = await runtime.execute(
		"const [a, b] = await Promise.all([pi.read('/a'), pi.read('/b')]); return [a, b];",
		async (_ref, args) => {
			const path = String((args as { path?: unknown }).path);
			await new Promise((resolve) => setTimeout(resolve, path === "/a" ? 40 : 5));
			return path;
		},
		baseOptions,
	);
	assert.equal(result.terminationReason, "completed");
	assert.deepEqual(result.value, ["/a", "/b"]);
});

test("print and console output is collected as logs", async () => {
	const runtime = new QuickJsRuntime();
	const result = await runtime.execute(
		"print('a'); print({ x: 1 }); console.log('c');",
		unexpectedHostCall,
		baseOptions,
	);
	assert.equal(result.terminationReason, "completed");
	assert.deepEqual(result.logs, ["a", '{"x":1}', "c"]);
});

test("log output is truncated at maxLogChars", async () => {
	const runtime = new QuickJsRuntime();
	const result = await runtime.execute("print('aaaaaaaaaaaaaaaaaaaa');", unexpectedHostCall, {
		...baseOptions,
		maxLogChars: 10,
	});
	assert.ok(result.logs.includes("[Pi Spindle log output truncated]"));
});

test("an infinite loop is stopped by the deadline", async () => {
	const runtime = new QuickJsRuntime();
	const result = await runtime.execute("while (true) {}", unexpectedHostCall, {
		...baseOptions,
		timeoutMs: 250,
	});
	assert.equal(result.terminationReason, "timed_out");
	assert.match(result.error ?? "", /timed out after 250ms/);
});

test("aborting during a host call cancels the program", async () => {
	const runtime = new QuickJsRuntime();
	const controller = new AbortController();
	const execution = runtime.execute(
		"return await pi.read('/x');",
		(_ref, _args, signal) =>
			new Promise((_resolve, reject) => {
				signal?.addEventListener("abort", () => reject(new Error("host call aborted")), {
					once: true,
				});
			}),
		{ ...baseOptions, signal: controller.signal },
	);
	setTimeout(() => controller.abort(), 50);
	const result = await execution;
	assert.equal(result.terminationReason, "aborted");
});

test("an already-aborted signal skips execution entirely", async () => {
	const runtime = new QuickJsRuntime();
	const controller = new AbortController();
	controller.abort();
	const result = await runtime.execute("while (true) {}", unexpectedHostCall, {
		...baseOptions,
		signal: controller.signal,
	});
	assert.equal(result.terminationReason, "aborted");
	assert.equal(result.error, "Execution cancelled");
	// Note: a pure busy loop inside the guest blocks the host thread, so an
	// abort raised *during* it cannot be observed until the deadline interrupt
	// fires; that is why the deadline path also reports cancellation. Aborts
	// are responsive before execution and while host calls are in flight (the
	// test above covers the latter).
});

test("the memory limit stops runaway allocation", async () => {
	const runtime = new QuickJsRuntime();
	const result = await runtime.execute(
		"const chunks = []; for (;;) chunks.push('x'.repeat(4096));",
		unexpectedHostCall,
		{ ...baseOptions, timeoutMs: 20_000, memoryLimitBytes: 16 * 1024 * 1024 },
	);
	assert.equal(result.terminationReason, "runtime_error");
	assert.match(result.error ?? "", /memory/i);
});

test("setTimeout callbacks run", async () => {
	const runtime = new QuickJsRuntime();
	const result = await runtime.execute(
		"let fired = 0; setTimeout(() => { fired = 1; }, 5); await new Promise((resolve) => setTimeout(resolve, 50)); return fired;",
		unexpectedHostCall,
		baseOptions,
	);
	assert.equal(result.terminationReason, "completed");
	assert.equal(result.value, 1);
});

test("π exposes only provided strings", async () => {
	const runtime = new QuickJsRuntime();
	const provided = await runtime.execute("return π.greeting;", unexpectedHostCall, {
		...baseOptions,
		strings: { greeting: "hi" },
	});
	assert.equal(provided.value, "hi");
	const missing = await runtime.execute("return π.nope;", unexpectedHostCall, {
		...baseOptions,
		strings: { greeting: "hi" },
	});
	assert.equal(missing.terminationReason, "runtime_error");
	assert.match(missing.error ?? "", /π\.nope is not defined.*provided: greeting/s);
});

test("runtime errors map back to the program's lines", async () => {
	const runtime = new QuickJsRuntime();
	const result = await runtime.execute(
		["const g = (): void => {", "  throw new Error('boom');", "};", "return g();"].join("\n"),
		unexpectedHostCall,
		baseOptions,
	);
	assert.equal(result.terminationReason, "runtime_error");
	// Dumped guest errors render like real Errors: name, message, then frames.
	assert.match(result.error ?? "", /^Error: boom/m);
	// The throw lives on program line 2; the emitted JS shifts it, and the
	// source map must move it back.
	assert.match(result.error ?? "", /program\.ts:2:\d+/);
});

test("a caller-supplied map is honored for caller-supplied code", async () => {
	const runtime = new QuickJsRuntime();
	const { transpileSpindleCode } = await import("./type-checker.ts");
	const code = "return (() => { throw new Error('late'); })();";
	const transpiled = transpileSpindleCode(code);
	const result = await runtime.execute("unused", unexpectedHostCall, {
		...baseOptions,
		transpiledCode: transpiled.javascript,
		sourceMap: transpiled.sourceMap,
	});
	assert.equal(result.terminationReason, "runtime_error");
	assert.match(result.error ?? "", /program\.ts:1:\d+/);
});

test("unbounded guest recursion raises a guest error instead of crashing the host", async () => {
	const runtime = new QuickJsRuntime();
	const result = await runtime.execute(
		"const recurse = (depth) => recurse(depth + 1); try { recurse(0); } catch (error) { return String(error); } return 'no error';",
		unexpectedHostCall,
		baseOptions,
	);
	assert.equal(result.terminationReason, "completed");
	assert.match(String(result.value), /stack/i);
});
