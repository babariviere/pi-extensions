import assert from "node:assert/strict";
import { test } from "node:test";

import { QuickJsRuntime } from "./quickjs-runtime.ts";

const baseOptions = {
	timeoutMs: 10_000,
	memoryLimitBytes: 32 * 1024 * 1024,
};

const unexpectedHostCall = async () => {
	throw new Error("unexpected host call");
};

const run = async (code: string): Promise<unknown> => {
	const runtime = new QuickJsRuntime();
	const result = await runtime.execute(code, unexpectedHostCall, baseOptions);
	assert.equal(result.terminationReason, "completed", result.error ?? "");
	return result.value;
};

test("AbortController exposes the platform shape", async () => {
	const value = await run(
		[
			"const controller = new AbortController();",
			"const seen = [];",
			"controller.signal.addEventListener('abort', (event) => seen.push(event.type));",
			"controller.signal.onabort = () => seen.push('onabort');",
			"const before = controller.signal.aborted;",
			"controller.abort();",
			"controller.abort();",
			"return [before, controller.signal.aborted, controller.signal.reason.name, seen];",
		].join("\n"),
	);
	assert.deepEqual(value, [false, true, "AbortError", ["onabort", "abort"]]);
});

test("an abort reason is preserved and throwIfAborted rethrows it", async () => {
	const value = await run(
		[
			"const controller = new AbortController();",
			"controller.abort(new Error('because'));",
			"let caught = 'none';",
			"try { controller.signal.throwIfAborted(); } catch (error) { caught = error.message; }",
			"return [controller.signal.reason.message, caught];",
		].join("\n"),
	);
	assert.deepEqual(value, ["because", "because"]);
});

test("a listener added after the abort never fires", async () => {
	const value = await run(
		[
			"const controller = new AbortController();",
			"controller.abort();",
			"let fired = false;",
			"controller.signal.addEventListener('abort', () => { fired = true; });",
			"return fired;",
		].join("\n"),
	);
	assert.equal(value, false);
});

test("AbortSignal.abort, timeout and any behave", async () => {
	assert.equal(await run("return AbortSignal.abort().aborted;"), true);
	assert.equal(await run("return AbortSignal.abort('why').reason;"), "why");
	assert.equal(
		await run(
			[
				"const signal = AbortSignal.timeout(5);",
				"await new Promise((resolve) => setTimeout(resolve, 40));",
				"return [signal.aborted, signal.reason.name];",
			].join("\n"),
		).then((value) => JSON.stringify(value)),
		JSON.stringify([true, "TimeoutError"]),
	);
	assert.equal(
		await run(
			[
				"const first = new AbortController();",
				"const second = new AbortController();",
				"const combined = AbortSignal.any([first.signal, second.signal]);",
				"second.abort('second won');",
				"return combined.reason;",
			].join("\n"),
		),
		"second won",
	);
});

test("aborting a host call rejects the guest and cancels the host work", async () => {
	const runtime = new QuickJsRuntime();
	let hostSawAbort = false;
	const result = await runtime.execute(
		[
			"const controller = new AbortController();",
			"setTimeout(() => controller.abort(new Error('enough')), 10);",
			"try {",
			"  await pi.bash({ command: 'sleep 30', signal: controller.signal });",
			"  return 'completed';",
			"} catch (error) {",
			"  return 'rejected: ' + error.message;",
			"}",
		].join("\n"),
		(_ref, _args, signal) =>
			new Promise((_resolve, reject) => {
				signal.addEventListener("abort", () => {
					hostSawAbort = true;
					reject(new Error("host call aborted"));
				});
			}),
		baseOptions,
	);
	assert.equal(result.terminationReason, "completed", result.error ?? "");
	assert.equal(result.value, "rejected: enough");
	assert.equal(hostSawAbort, true);
});

test("the signal never reaches the host argument schema", async () => {
	const runtime = new QuickJsRuntime();
	let observed: Record<string, unknown> = {};
	const result = await runtime.execute(
		"const controller = new AbortController(); return await pi.bash({ command: 'true', signal: controller.signal });",
		async (_ref, args) => {
			observed = args;
			return { ok: true };
		},
		baseOptions,
	);
	assert.equal(result.terminationReason, "completed", result.error ?? "");
	assert.deepEqual(Object.keys(observed).sort(), ["command"]);
});

test("an already-aborted signal fails before the call is made", async () => {
	const runtime = new QuickJsRuntime();
	let calls = 0;
	const result = await runtime.execute(
		[
			"const controller = new AbortController();",
			"controller.abort(new Error('too late'));",
			"try {",
			"  await pi.bash({ command: 'true', signal: controller.signal });",
			"  return 'completed';",
			"} catch (error) { return error.message; }",
		].join("\n"),
		async () => {
			calls++;
			return { ok: true };
		},
		baseOptions,
	);
	assert.equal(result.value, "too late");
	assert.equal(calls, 0);
});

test("one call's cancellation leaves its siblings running", async () => {
	const runtime = new QuickJsRuntime();
	const result = await runtime.execute(
		[
			"const controller = new AbortController();",
			"setTimeout(() => controller.abort(new Error('drop one')), 10);",
			"const settled = await Promise.all([",
			"  pi.bash({ command: 'slow', signal: controller.signal }).then(() => 'a-ok', (error) => 'a-' + error.message),",
			"  pi.bash({ command: 'fast' }).then(() => 'b-ok', (error) => 'b-' + error.message),",
			"]);",
			"return settled;",
		].join("\n"),
		(_ref, args, signal) => {
			if ((args as { command?: string }).command === "fast") return Promise.resolve({ ok: true });
			return new Promise((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(new Error("aborted")));
			});
		},
		baseOptions,
	);
	assert.equal(result.terminationReason, "completed", result.error ?? "");
	assert.deepEqual(result.value, ["a-drop one", "b-ok"]);
});

test("mapLimit stops launching work once its signal aborts", async () => {
	const runtime = new QuickJsRuntime();
	let started = 0;
	const result = await runtime.execute(
		[
			"const controller = new AbortController();",
			"const items = Array.from({ length: 40 }, (unused, index) => index);",
			"try {",
			"  await mapLimit(items, async (item) => {",
			"    const output = await pi.read('/f' + item);",
			"    if (item === 1) controller.abort(new Error('found it'));",
			"    return output;",
			"  }, { concurrency: 2, signal: controller.signal });",
			"  return 'completed';",
			"} catch (error) { return error.message; }",
		].join("\n"),
		async (ref) => {
			// Only item work counts: mapLimit also opens and closes an activity span,
			// which is a host call of its own.
			if (ref.startsWith("pi.")) started++;
			return "x";
		},
		baseOptions,
	);
	assert.equal(result.terminationReason, "completed", result.error ?? "");
	assert.equal(result.value, "found it");
	// The pool must abandon the remaining items rather than walk all 40.
	assert.ok(started < 40, `expected an early stop, but ${started} items ran`);
});

test("an aborted signal passed to mapLimit runs nothing", async () => {
	const runtime = new QuickJsRuntime();
	let started = 0;
	const result = await runtime.execute(
		[
			"const controller = new AbortController();",
			"controller.abort(new Error('nope'));",
			"try {",
			"  await mapLimit([1, 2, 3], async (item) => pi.read('/f' + item), { signal: controller.signal });",
			"  return 'completed';",
			"} catch (error) { return error.message; }",
		].join("\n"),
		async (ref) => {
			if (ref.startsWith("pi.")) started++;
			return "x";
		},
		baseOptions,
	);
	assert.equal(result.value, "nope");
	assert.equal(started, 0);
});
