import assert from "node:assert/strict";
import { test } from "node:test";
import { createTaskDeliverer, isInitialSession, readTaskFile, TASK_DELIVERY_DELAY_MS } from "./task-delivery.ts";

function deliverer(taskFile: string | undefined, opts: { task?: string | undefined } = { task: "Task: do it" }) {
	const task = opts.task;
	const sent: string[] = [];
	const errors: string[] = [];
	const reads: string[] = [];
	const deliver = createTaskDeliverer({
		taskFile: () => taskFile,
		read: (path) => {
			reads.push(path);
			return task;
		},
		send: (text) => sent.push(text),
		onError: (message) => errors.push(message),
		defer: (run) => run(),
	});
	return { deliver, sent, errors, reads };
}

test("delivers the task file as the first user message on the startup session", () => {
	const { deliver, sent, reads } = deliverer("/run/worker-0.task.md");
	deliver("startup");
	assert.deepEqual(sent, ["Task: do it"]);
	assert.deepEqual(reads, ["/run/worker-0.task.md"]);
});

test("delivers once, never again on a later session in the same process", () => {
	// A /new, /resume, fork or reload must not re-send the task.
	const { deliver, sent } = deliverer("/run/worker-0.task.md");
	deliver("startup");
	deliver("startup");
	deliver("new");
	deliver("resume");
	assert.equal(sent.length, 1);
});

test("ignores every session reason other than startup", () => {
	for (const reason of ["reload", "new", "resume", "fork", undefined]) {
		const { deliver, sent } = deliverer("/run/worker-0.task.md");
		deliver(reason);
		assert.deepEqual(sent, [], `reason ${String(reason)} should not deliver`);
	}
	assert.equal(isInitialSession("startup"), true);
	assert.equal(isInitialSession("reload"), false);
});

test("does nothing when the process was given no task file", () => {
	for (const flag of [undefined, "", "   "]) {
		const { deliver, sent, errors, reads } = deliverer(flag);
		deliver("startup");
		assert.deepEqual(sent, []);
		assert.deepEqual(errors, []);
		assert.deepEqual(reads, []);
	}
});

test("reports an unreadable task instead of starting an empty turn", () => {
	const { deliver, sent, errors } = deliverer("/run/gone.task.md", {});
	deliver("startup");
	assert.deepEqual(sent, []);
	assert.equal(errors.length, 1);
	assert.match(errors[0], /task file is missing or empty/);
	// Claimed even though it failed: a broken task is reported once, not retried.
	deliver("startup");
	assert.equal(errors.length, 1);
});

test("the send is deferred out of session_start, and claimed before it runs", () => {
	// A turn started inside session_start leaves the TUI thinking the session is
	// idle, and the human's first keystroke is then refused by pi.
	const sent: string[] = [];
	const scheduled: (() => void)[] = [];
	const deliver = createTaskDeliverer({
		taskFile: () => "/run/worker-0.task.md",
		read: () => "Task: do it",
		send: (text) => sent.push(text),
		defer: (run) => scheduled.push(run),
	});

	deliver("startup");
	assert.deepEqual(sent, []);
	assert.equal(scheduled.length, 1);

	// A second startup before the deferred send runs must not queue it twice.
	deliver("startup");
	assert.equal(scheduled.length, 1);

	for (const run of scheduled) run();
	assert.deepEqual(sent, ["Task: do it"]);
	assert.ok(TASK_DELIVERY_DELAY_MS > 0);
});

test("readTaskFile treats a blank or unreadable file as no task", () => {
	assert.equal(
		readTaskFile("/x", () => "   \n"),
		undefined,
	);
	assert.equal(
		readTaskFile("/x", () => {
			throw new Error("ENOENT");
		}),
		undefined,
	);
	assert.equal(
		readTaskFile("/x", () => "Task: go"),
		"Task: go",
	);
});
