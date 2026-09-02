import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyPiBashError, piBashResultError } from "../core/pi-bash-error.ts";
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

test("a classified bash exit settles through the host bridge", async () => {
	const runtime = new QuickJsRuntime();
	const result = await runtime.execute(
		"return await pi.bash({ command: 'exit 3', settle: true });",
		async () => {
			throw classifyPiBashError(new Error("boom\n\nCommand exited with code 3"));
		},
		baseOptions,
	);
	assert.equal(result.terminationReason, "completed");
	assert.deepEqual(result.value, {
		ok: false,
		output: "boom",
		details: null,
		exitCode: 3,
		error: "boom\n\nCommand exited with code 3",
	});
});

test("a settled bash exit survives a rewritten error message", async () => {
	const runtime = new QuickJsRuntime();
	const result = await runtime.execute(
		"const r = await pi.bash({ command: 'exit 7', settle: true }); return [r.exitCode, r.output, r.error].join('|');",
		async () => {
			// The classified exit crosses the bridge even though middleware replaced
			// the text the old message-parsing path depended on.
			const classified = classifyPiBashError(new Error("boom\n\nCommand exited with code 7"));
			throw piBashResultError(classified, "[redacted by middleware]");
		},
		baseOptions,
	);
	assert.equal(result.value, "7|[redacted by middleware]|[redacted by middleware]");
});

/** Collect every batched item transition a program emits, in order. */
const recordItems = async (code: string) => {
	const spans: Array<Record<string, unknown>> = [];
	const items: Array<Record<string, unknown>> = [];
	const result = await new QuickJsRuntime().execute(
		code,
		async (ref, args) => {
			const payload = (args ?? {}) as Record<string, unknown>;
			if (ref === "spindle.$spanStart") spans.push(payload);
			if (ref === "spindle.$items") {
				for (const entry of payload.items as Array<Record<string, unknown>>) items.push(entry);
			}
			return {};
		},
		baseOptions,
	);
	return { result, spans, items };
};

test("mapLimit infers per-item progress and labels elements from their value", async () => {
	const { result, spans, items } = await recordItems(
		"return await mapLimit(['a.ts', 'b.ts', 'c.ts', 'd.ts'], (f) => f.toUpperCase(), 2);",
	);
	assert.equal(result.terminationReason, "completed");
	assert.deepEqual(result.value, ["A.TS", "B.TS", "C.TS", "D.TS"]);
	assert.equal(spans.length, 1);
	assert.equal(spans[0]!.itemCount, 4);
	assert.equal(spans[0]!.concurrency, 2);
	// A string element is its own best label; the host was told nothing.
	const completed = items.filter((item) => item.status === "completed");
	assert.deepEqual(
		completed.map((item) => item.label),
		["a.ts", "b.ts", "c.ts", "d.ts"],
	);
	assert.deepEqual(new Set(completed.map((item) => item.total)), new Set([4]));
});

test("mapLimit labels object elements from a conventional key", async () => {
	const { items } = await recordItems(
		"return await mapLimit([{ path: '/x' }, { path: '/y' }, { path: '/z' }, { path: '/w' }], (o) => o.path);",
	);
	assert.deepEqual(
		items.filter((item) => item.status === "completed").map((item) => item.label),
		["/x", "/y", "/z", "/w"],
	);
});

test("a failing element is reported as failed without masking the rejection", async () => {
	const { result, items } = await recordItems(
		[
			"try {",
			"  await mapLimit(['a', 'b', 'c', 'd'], (v) => { if (v === 'c') throw new Error('boom'); return v; });",
		"} catch (error) {",
		"  return 'caught: ' + error.message;",
		"}",
		"return 'not reached';",
		].join("\n"),
	);
	assert.equal(result.terminationReason, "completed");
	assert.equal(result.value, "caught: boom");
	const failed = items.filter((item) => item.status === "failed");
	assert.equal(failed.length, 1);
	assert.equal(failed[0]!.label, "c");
});

test("a narrow fan-out emits no span and no item traffic", async () => {
	const { result, spans, items } = await recordItems(
		"return await Promise.all([1, 2, 3].map(async (n) => n * 2));",
	);
	assert.equal(result.terminationReason, "completed");
	assert.deepEqual(result.value, [2, 4, 6]);
	assert.equal(spans.length, 0);
	assert.equal(items.length, 0);
});

test("a wide Promise.all reports progress without the program asking", async () => {
	const { result, spans, items } = await recordItems(
		"return await Promise.all([1, 2, 3, 4, 5].map(async (n) => n * 2));",
	);
	assert.equal(result.terminationReason, "completed");
	assert.deepEqual(result.value, [2, 4, 6, 8, 10]);
	assert.equal(spans.length, 1);
	assert.equal(spans[0]!.itemCount, 5);
	// Already-started promises carry nothing to name them with, so entries fall
	// back to their position.
	const completed = items.filter((item) => item.status === "completed");
	assert.equal(completed.length, 5);
	assert.deepEqual(
		completed.map((item) => item.label),
		["#1", "#2", "#3", "#4", "#5"],
	);
});

test("a batch edit accepts the same short keys as the single-edit form", async () => {
	let received: Record<string, unknown> | undefined;
	const result = await new QuickJsRuntime().execute(
		"return await pi.edit({ path: '/x', edits: [{ old: 'a', new: 'b' }, { oldText: 'c', newText: 'd' }] });",
		async (_ref, args) => {
			received = args as Record<string, unknown>;
			return { ok: true };
		},
		baseOptions,
	);
	assert.equal(result.terminationReason, "completed");
	// The alias table only rewrites top-level keys, so entries are mapped too.
	assert.deepEqual(received?.edits, [
		{ oldText: "a", newText: "b" },
		{ oldText: "c", newText: "d" },
	]);
});
