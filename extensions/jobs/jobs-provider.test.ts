import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { readFile, stat } from "node:fs/promises";
import { test } from "node:test";
import { JobsProvider, type AnnouncementTiming, type JobSnapshot } from "./jobs-provider.ts";
import { Value } from "typebox/value";
import { createActionsTool } from "../shared/action-tools.ts";

const context = { cwd: process.cwd() } as never;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const fast: Partial<AnnouncementTiming> = { quietMs: 50, batchWindowMs: -1, batchMaxDelayMs: 0, maxDelayMs: 1_000 };
const start = (provider: JobsProvider, command: string) =>
	provider.invoke("start", { name: "test", command }, context) as Promise<JobSnapshot>;

test("list is a non-claiming alias for status and unknown waits fail immediately", async () => {
	const sent: JobSnapshot[] = [];
	let idle = false;
	const jobs = new JobsProvider(
		async (command) => command,
		(completed) => sent.push(...completed),
		() => idle,
	);
	try {
		const job = await start(jobs, "echo ready");
		await waitForExit(jobs, job.id);
		assert.deepEqual(await jobs.invoke("list", {}, context), await jobs.invoke("status", {}, context));
		await assert.rejects(
			jobs.invoke("wait", { id: "missing", waitMs: 120_000 }, context),
			/Unknown job: missing.*list/,
		);
		const empty = new JobsProvider(
			async (command) => command,
			() => {},
		);
		try {
			assert.deepEqual(await empty.invoke("list", {}, context), []);
		} finally {
			await empty.close();
		}
		assert.equal(sent.length, 0);
		// Neither listing action consumes the pending completion.
		idle = true;
		jobs.flushCompletions();
		assert.deepEqual(
			sent.map((done) => done.id),
			[job.id],
		);
	} finally {
		await jobs.close();
	}
});

test("aborting an active wait releases it without stopping or claiming the session-owned job", {
	timeout: 5_000,
}, async () => {
	const sent: JobSnapshot[] = [];
	const updates: string[] = [];
	let idle = false;
	const jobs = new JobsProvider(
		async (command) => command,
		(completed) => sent.push(...completed),
		() => idle,
	);
	try {
		const job = await start(jobs, "sleep 0.2; echo survived");
		const controller = new AbortController();
		const reason = new Error("cancelled wait");
		const waiting = jobs.invoke("wait", { id: job.id, waitMs: 120_000 }, {
			cwd: process.cwd(),
			signal: controller.signal,
			update: (message: string) => updates.push(message),
		} as never);
		controller.abort(reason);
		assert.equal(((await waiting) as JobSnapshot).state, "running");
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
		assert.equal(jobs.running()[0]?.id, job.id);
		assert.ok(updates[0]?.includes(job.id));
		assert.ok(updates[0]?.includes(job.outputPath));
		await waitForExit(jobs, job.id);
		idle = true;
		jobs.flushCompletions();
		assert.deepEqual(
			sent.map((done) => done.id),
			[job.id],
		);
	} finally {
		await jobs.close();
	}
});

async function waitForExit(provider: JobsProvider, id: string): Promise<void> {
	const deadline = Date.now() + 3_000;
	while (Date.now() < deadline) {
		const jobs = (await provider.invoke("status", {}, context)) as JobSnapshot[];
		if (jobs.find((job) => job.id === id)?.endedAt) return;
		await sleep(10);
	}
	assert.fail("Job did not exit in time");
}

test("bounded and terminal waits remove abort listeners; a pre-aborted wait does not claim completion", async () => {
	const sent: JobSnapshot[] = [];
	let idle = false;
	const jobs = new JobsProvider(
		async (command) => command,
		(completed) => sent.push(...completed),
		() => idle,
	);
	try {
		const job = await start(jobs, "sleep 0.2; echo ready");
		const controller = new AbortController();
		const ctx = { cwd: process.cwd(), signal: controller.signal } as never;
		const running = (await jobs.invoke("wait", { id: job.id, waitMs: 0 }, ctx)) as JobSnapshot;
		assert.equal(running.state, "running");
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
		await waitForExit(jobs, job.id);
		const aborted = (await jobs.invoke("wait", { id: job.id }, {
			cwd: process.cwd(),
			signal: AbortSignal.abort(new Error("already aborted")),
		} as never)) as JobSnapshot;
		assert.equal(aborted.state, "done");
		idle = true;
		jobs.flushCompletions();
		assert.deepEqual(
			sent.map((done) => done.id),
			[job.id],
		);
		const another = await start(jobs, "echo terminal");
		const done = (await jobs.invoke("wait", { id: another.id }, ctx)) as JobSnapshot;
		assert.equal(done.state, "done");
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
		assert.match(await readFile(done.outputPath, "utf8"), /terminal/);
	} finally {
		await jobs.close();
	}
});

test("a running job remains running across calls, then wakes only when unclaimed", async () => {
	const sent: JobSnapshot[] = [];
	let changes = 0;
	const jobs = new JobsProvider(
		async (command) => command,
		(completed) => sent.push(...completed),
		undefined,
		() => changes++,
		fast,
	);
	try {
		const job = await start(jobs, "sleep 0.15; echo completed");
		assert.equal(job.state, "running");
		assert.deepEqual(
			jobs.running().map((item) => item.id),
			[job.id],
		);
		assert.equal(changes, 1);
		assert.equal(((await jobs.invoke("wait", { id: job.id, waitMs: 0 }, context)) as JobSnapshot).state, "running");
		assert.equal(((await jobs.invoke("status", {}, context)) as JobSnapshot[])[0]?.state, "running");
		const deadline = Date.now() + 3_000;
		while (sent.length === 0 && Date.now() < deadline) await sleep(30);
		assert.deepEqual(jobs.running(), []);
		assert.equal(changes, 2);
		assert.equal(sent.length, 1);
		assert.equal(sent[0]?.state, "done");
		assert.match(await readFile(job.outputPath, "utf8"), /completed/);
	} finally {
		await jobs.close();
	}
});

test("a terminal wait claims the result, a stopped job cannot wake the model", async () => {
	const sent: JobSnapshot[] = [];
	let changes = 0;
	const jobs = new JobsProvider(
		async (command) => command,
		(completed) => sent.push(...completed),
		undefined,
		() => changes++,
	);
	try {
		const finished = await start(jobs, "echo claimed");
		const result = (await jobs.invoke("wait", { id: finished.id }, context)) as JobSnapshot;
		assert.equal(result.state, "done");
		assert.equal(result.outputPath, finished.outputPath);
		assert.match(await readFile(result.outputPath, "utf8"), /claimed/);
		const stopped = await start(jobs, "sleep 30");
		const beforeStop = changes;
		assert.equal(((await jobs.invoke("stop", { id: stopped.id }, context)) as JobSnapshot).state, "cancelled");
		assert.equal(changes, beforeStop + 1);
		assert.deepEqual(jobs.running(), []);
		await sleep(300);
		assert.deepEqual(sent, []);
	} finally {
		await jobs.close();
	}
});

test("a completion during an active turn stays pending until wait claims it", async () => {
	const sent: JobSnapshot[] = [];
	let idle = false;
	const jobs = new JobsProvider(
		async (command) => command,
		(completed) => sent.push(...completed),
		() => idle,
	);
	try {
		const started = await start(jobs, "echo claimed-later");
		await sleep(250); // Longer than the announcement delay: the old code already queued a wake-up here.
		assert.deepEqual(sent, []);
		const claimed = (await jobs.invoke("wait", { id: started.id }, context)) as JobSnapshot;
		assert.equal(claimed.state, "done");
		idle = true;
		jobs.flushCompletions();
		assert.deepEqual(sent, []);
	} finally {
		await jobs.close();
	}
});

for (const exitCode of [0, 7]) {
	test(`status and output file reads do not claim an exit ${exitCode} result during an active turn`, async () => {
		const sent: JobSnapshot[] = [];
		let idle = false;
		const jobs = new JobsProvider(
			async (command) => command,
			(completed) => sent.push(...completed),
			() => idle,
		);
		try {
			const started = await start(jobs, `echo read-directly; exit ${exitCode}`);
			await waitForExit(jobs, started.id);
			const [result] = (await jobs.invoke("status", {}, context)) as JobSnapshot[];
			assert.ok(result);
			assert.equal(result.state, exitCode === 0 ? "done" : "failed");
			assert.equal(result.exitCode, exitCode);
			assert.equal(result.outputPath, started.outputPath);
			assert.match(await readFile(result.outputPath, "utf8"), /read-directly/);
			idle = true;
			jobs.flushCompletions();
			await sleep(250);
			jobs.flushCompletions();
			assert.deepEqual(
				sent.map((job) => job.id),
				[started.id],
			);
		} finally {
			await jobs.close();
		}
	});
}

test("reading a running output file does not claim a later completion", async () => {
	const sent: JobSnapshot[] = [];
	let idle = false;
	const jobs = new JobsProvider(
		async (command) => command,
		(completed) => sent.push(...completed),
		() => idle,
	);
	try {
		const started = await start(jobs, "echo progress; sleep 0.3; echo completed-later");
		const result = (await jobs.invoke("wait", { id: started.id, waitMs: 50 }, context)) as JobSnapshot;
		assert.equal(result.state, "running");
		assert.equal(result.outputPath, started.outputPath);
		await readFile(result.outputPath, "utf8");
		await waitForExit(jobs, started.id);
		await sleep(250);
		assert.equal(sent.length, 0);
		idle = true;
		jobs.flushCompletions();
		jobs.flushCompletions();
		assert.deepEqual(
			sent.map((job) => job.id),
			[started.id],
		);
	} finally {
		await jobs.close();
	}
});

test("an unclaimed completion during a turn wakes once the turn settles", async () => {
	const sent: JobSnapshot[] = [];
	let idle = false;
	const jobs = new JobsProvider(
		async (command) => command,
		(completed) => sent.push(...completed),
		() => idle,
	);
	try {
		const started = await start(jobs, "echo unclaimed");
		await sleep(250);
		assert.equal(sent.length, 0);
		assert.equal(
			((await jobs.invoke("status", {}, context)) as JobSnapshot[]).find((job) => job.id === started.id)?.state,
			"done",
		);
		idle = true;
		jobs.flushCompletions();
		jobs.flushCompletions();
		assert.deepEqual(
			sent.map((job) => job.id),
			[started.id],
		);
	} finally {
		await jobs.close();
	}
});

test("settling batches pending completions and excludes claimed and stopped jobs", async () => {
	const batches: JobSnapshot[][] = [];
	let idle = false;
	const jobs = new JobsProvider(
		async (command) => command,
		(completed) => {
			batches.push(completed);
			idle = false; // Sending a follow-up may immediately start the next turn.
		},
		() => idle,
	);
	try {
		const done = await start(jobs, "echo done");
		const failed = await start(jobs, "echo failed; exit 7");
		const waited = await start(jobs, "echo waited");
		const stopped = await start(jobs, "sleep 30");
		await jobs.invoke("wait", { id: waited.id }, context);
		await jobs.invoke("stop", { id: stopped.id }, context);
		await Promise.all([done, failed].map((job) => waitForExit(jobs, job.id)));
		await sleep(250);
		assert.equal(batches.length, 0);
		idle = true;
		jobs.flushCompletions();
		idle = true;
		jobs.flushCompletions();
		assert.equal(batches.length, 1);
		assert.deepEqual(
			batches[0]?.map((job) => [job.id, job.state, job.exitCode]),
			[
				[done.id, "done", 0],
				[failed.id, "failed", 7],
			],
		);
		await sleep(250);
		assert.equal(batches.length, 1);
	} finally {
		await jobs.close();
	}
});

test("the announcement timer flushes all pending completions together", async () => {
	const batches: JobSnapshot[][] = [];
	let idle = false;
	const jobs = new JobsProvider(
		async (command) => command,
		(completed) => batches.push(completed),
		() => idle,
		undefined,
		fast,
	);
	try {
		const first = await start(jobs, "echo first");
		const second = await start(jobs, "echo second");
		await Promise.all([first, second].map((job) => waitForExit(jobs, job.id)));
		await sleep(250);
		assert.equal(batches.length, 0);
		idle = true;
		const third = await start(jobs, "echo third");
		const deadline = Date.now() + 3_000;
		while (!batches.length && Date.now() < deadline) await sleep(10);
		assert.deepEqual(
			batches.map((batch) => batch.map((job) => job.id)),
			[[first.id, second.id, third.id]],
		);
		await sleep(250);
		jobs.flushCompletions();
		assert.equal(batches.length, 1);
	} finally {
		await jobs.close();
	}
});

test("shutdown suppresses pending completion batches", async () => {
	const batches: JobSnapshot[][] = [];
	let idle = false;
	const jobs = new JobsProvider(
		async (command) => command,
		(completed) => batches.push(completed),
		() => idle,
	);
	try {
		const started = await start(jobs, "echo pending");
		await waitForExit(jobs, started.id);
		await jobs.close();
		idle = true;
		jobs.flushCompletions();
		await sleep(250);
		assert.deepEqual(batches, []);
	} finally {
		await jobs.close();
	}
});

test("sandbox wrapping is applied before launch and rejects unsafe launches", async () => {
	const jobs = new JobsProvider(
		async () => {
			throw new Error("sandbox refused");
		},
		() => {},
	);
	await assert.rejects(start(jobs, "echo hi"), /sandbox refused/);
	assert.deepEqual(await jobs.invoke("status", {}, context), []);
	await jobs.close();
});

test("a failed command remains queryable and is not reported as done", async () => {
	const sent: JobSnapshot[] = [];
	const jobs = new JobsProvider(
		async (command) => command,
		(completed) => sent.push(...completed),
	);
	try {
		const started = await start(jobs, "echo failure >&2; exit 7");
		const result = (await jobs.invoke("wait", { id: started.id }, context)) as JobSnapshot;
		assert.equal(result.state, "failed");
		assert.equal(result.exitCode, 7);
		assert.equal(((await jobs.invoke("status", {}, context)) as JobSnapshot[])[0]?.state, "failed");
		assert.equal(result.outputPath, started.outputPath);
		assert.match(await readFile(result.outputPath, "utf8"), /failure/);
		await sleep(250);
		assert.deepEqual(sent, []);
	} finally {
		await jobs.close();
	}
});

test("output files retain the capture cap and are removed on session cleanup", async () => {
	const jobs = new JobsProvider(
		async (command) => command,
		() => {},
	);
	let outputPath: string;
	try {
		const started = await start(
			jobs,
			`${JSON.stringify(process.execPath)} -e 'process.stdout.write("x".repeat(9 * 1024 * 1024))'`,
		);
		const result = (await jobs.invoke("wait", { id: started.id }, context)) as JobSnapshot;
		outputPath = result.outputPath;
		assert.equal(result.state, "done");
		assert.equal(result.logTruncated, true);
		assert.equal((await stat(outputPath)).size, 8 * 1024 * 1024);
	} finally {
		await jobs.close();
	}
	await assert.rejects(stat(outputPath), { code: "ENOENT" });
});

test("jobs native tools retain structured output schemas and codemode exposure", async () => {
	const jobs = new JobsProvider(
		async (command) => command,
		() => {},
	);
	const actions = await jobs.list({}, context);
	const descriptor = actions.find((action) => action.name === "start")!;
	const tool = createActionsTool(jobs, actions);
	assert.equal(tool.name, "jobs");
	assert.equal(tool.exposure, "codemode");
	assert.ok(tool.outputSchema);
	assert.match(tool.description, /long-running commands only/);
	assert.match(tool.description, /Use bash for short commands/);
	assert.match(descriptor.description, /capturing stdout\/stderr/);
	assert.match(tool.namespace?.instructions ?? "", /codemode with Promise\.allSettled/);
	assert.match(tool.namespace?.instructions ?? "", /parallelism alone does not require jobs/);
	assert.doesNotMatch(tool.description + tool.namespace?.instructions, /long-running or parallel/);
	assert.match(tool.description, /If only job completion remains, end your turn/);
	assert.match(tool.description, /even when your next step depends on it/);
	assert.match(tool.description, /Do not poll or use shell sleeps/);
	assert.match(tool.namespace?.instructions ?? "", /Jobs survive turn end, but not shutdown\/reload/);
	assert.match(tool.namespace?.instructions ?? "", /Terminal waits claim results; list\/status and log reads do not/);
	assert.ok(tool.description.length < 1_000, "keep the always-listed tool description compact");
	assert.ok((tool.namespace?.instructions?.length ?? 0) < 1_000, "avoid duplicating the action descriptions");
	assert.match(tool.namespace?.instructions ?? "", /Use read or bash with rg\/tail/);
	assert.deepEqual(
		actions.map((action) => action.name),
		["start", "list", "status", "wait", "stop"],
	);
	assert.equal(await jobs.describe("logs", context), undefined);
	assert.ok(!Value.Check(tool.parameters, { action: "logs", id: "job" }));
	assert.ok(!Value.Check(tool.parameters, { action: "status", maxChars: 4000 }));
	await assert.rejects(
		tool.execute("call", { action: "logs", id: "job" }, undefined, undefined, context),
		/Unknown jobs action: logs/,
	);
	for (const name of ["start", "list", "wait"]) {
		assert.match(actions.find((action) => action.name === name)!.description, /outputPath/);
	}
	assert.equal(actions.find((action) => action.name === "status")!.description, "Alias for list.");
	assert.match(actions.find((action) => action.name === "wait")!.description, /Optional bounded wait/);
	assert.doesNotMatch(
		tool.description + tool.namespace?.instructions,
		/legacy|deprecated|retained for compatibility/i,
	);
	assert.doesNotMatch(tool.description + tool.namespace?.instructions, /only when the next step depends/i);
	assert.ok(Value.Check(tool.parameters, { action: "list" }));
	assert.ok(!Value.Check(tool.parameters, { action: "list", maxChars: 4000 }));
	const listed = await tool.execute("call", { action: "list" }, undefined, undefined, context);
	assert.deepEqual(listed.structuredContent, []);
	assert.ok(Value.Check(descriptor.inputSchema, { name: "check", command: "echo ready" }));
	assert.ok(!Value.Check(descriptor.inputSchema, { name: "check" }));
	const result = await tool.execute(
		"call",
		{ action: "start", name: "check", command: "echo ready" },
		undefined,
		undefined,
		context,
	);
	assert.ok(Value.Check(descriptor.outputSchema!, result.structuredContent));
	assert.equal((result.structuredContent as unknown as JobSnapshot).state, "running");
	await jobs.close();
});

test("the quiet window resets on each completion so staggered exits are grouped", async () => {
	const batches: JobSnapshot[][] = [];
	const jobs = new JobsProvider(
		async (command) => command,
		(completed) => batches.push(completed),
		() => true,
		undefined,
		{ quietMs: 400, batchWindowMs: -1, batchMaxDelayMs: 0, maxDelayMs: 5_000 },
	);
	try {
		const first = await start(jobs, "echo first");
		const second = await start(jobs, "sleep 0.25; echo second");
		const third = await start(jobs, "sleep 0.5; echo third");
		const deadline = Date.now() + 3_000;
		while (!batches.length && Date.now() < deadline) await sleep(10);
		await sleep(100);
		assert.deepEqual(
			batches.map((batch) => batch.map((job) => job.id)),
			[[first.id, second.id, third.id]],
		);
	} finally {
		await jobs.close();
	}
});

test("the quiet window is capped by the maximum delay", async () => {
	const batches: JobSnapshot[][] = [];
	const jobs = new JobsProvider(
		async (command) => command,
		(completed) => batches.push(completed),
		() => true,
		undefined,
		{ quietMs: 5_000, batchWindowMs: -1, batchMaxDelayMs: 0, maxDelayMs: 200 },
	);
	try {
		const started = Date.now();
		const job = await start(jobs, "echo capped");
		const deadline = Date.now() + 3_000;
		while (!batches.length && Date.now() < deadline) await sleep(10);
		assert.ok(Date.now() - started < 1_500);
		assert.deepEqual(
			batches.map((batch) => batch.map((item) => item.id)),
			[[job.id]],
		);
	} finally {
		await jobs.close();
	}
});

test("successes are held until the rest of their batch finishes", async () => {
	const batches: JobSnapshot[][] = [];
	const jobs = new JobsProvider(
		async (command) => command,
		(completed) => batches.push(completed),
		() => true,
		undefined,
		{ quietMs: 100, batchWindowMs: 5_000, batchMaxDelayMs: 5_000, maxDelayMs: 200 },
	);
	try {
		const quick = await start(jobs, "echo quick");
		const slow = await start(jobs, "sleep 0.7; echo slow");
		await sleep(500);
		assert.equal(batches.length, 0, "the batch is still running, so the quick success waits past maxDelayMs");
		const deadline = Date.now() + 3_000;
		while (!batches.length && Date.now() < deadline) await sleep(10);
		await sleep(150);
		assert.deepEqual(
			batches.map((batch) => batch.map((job) => job.id)),
			[[quick.id, slow.id]],
		);
	} finally {
		await jobs.close();
	}
});

test("the batch hold is capped", async () => {
	const batches: JobSnapshot[][] = [];
	const jobs = new JobsProvider(
		async (command) => command,
		(completed) => batches.push(completed),
		() => true,
		undefined,
		{ quietMs: 50, batchWindowMs: 5_000, batchMaxDelayMs: 300, maxDelayMs: 1_000 },
	);
	try {
		const quick = await start(jobs, "echo quick");
		await start(jobs, "sleep 30");
		const deadline = Date.now() + 3_000;
		while (!batches.length && Date.now() < deadline) await sleep(10);
		assert.deepEqual(
			batches.map((batch) => batch.map((job) => job.id)),
			[[quick.id]],
		);
	} finally {
		await jobs.close();
	}
});

test("a failure skips the batch hold", async () => {
	const batches: JobSnapshot[][] = [];
	const jobs = new JobsProvider(
		async (command) => command,
		(completed) => batches.push(completed),
		() => true,
		undefined,
		{ quietMs: 50, batchWindowMs: 5_000, batchMaxDelayMs: 5_000, maxDelayMs: 1_000 },
	);
	try {
		const broken = await start(jobs, "exit 3");
		await start(jobs, "sleep 30");
		const deadline = Date.now() + 3_000;
		while (!batches.length && Date.now() < deadline) await sleep(10);
		assert.deepEqual(
			batches.map((batch) => batch.map((job) => [job.id, job.state])),
			[[[broken.id, "failed"]]],
		);
	} finally {
		await jobs.close();
	}
});

test("settling restarts the grouping window instead of announcing immediately", async () => {
	const batches: JobSnapshot[][] = [];
	let idle = false;
	const jobs = new JobsProvider(
		async (command) => command,
		(completed) => batches.push(completed),
		() => idle,
		undefined,
		{ quietMs: 300, batchWindowMs: -1, batchMaxDelayMs: 0, maxDelayMs: 5_000 },
	);
	try {
		const during = await start(jobs, "echo during-turn");
		await waitForExit(jobs, during.id);
		await sleep(400);
		assert.equal(batches.length, 0);
		idle = true;
		jobs.settle();
		assert.equal(batches.length, 0);
		const after = await start(jobs, "sleep 0.1; echo after-turn");
		const deadline = Date.now() + 3_000;
		while (!batches.length && Date.now() < deadline) await sleep(10);
		assert.deepEqual(
			batches.map((batch) => batch.map((job) => job.id)),
			[[during.id, after.id]],
		);
		jobs.settle();
		await sleep(400);
		assert.equal(batches.length, 1);
	} finally {
		await jobs.close();
	}
});

test("a job finishes when its shell exits even if a background descendant holds its output", async () => {
	const jobs = new JobsProvider(
		async (command) => command,
		() => {},
	);
	try {
		const started = await start(jobs, "sleep 5 & echo parent-done");
		const begin = Date.now();
		const result = (await jobs.invoke("wait", { id: started.id, waitMs: 4_000 }, context)) as JobSnapshot;
		assert.equal(result.state, "done");
		assert.equal(result.exitCode, 0);
		assert.ok(Date.now() - begin < 3_000);
		assert.match(await readFile(result.outputPath, "utf8"), /parent-done/);
	} finally {
		await jobs.close();
	}
});

test("wait returns early when its tool call is aborted", async () => {
	const jobs = new JobsProvider(
		async (command) => command,
		() => {},
	);
	try {
		const started = await start(jobs, "sleep 5");
		const controller = new AbortController();
		const begin = Date.now();
		const waiting = jobs.invoke("wait", { id: started.id, waitMs: 4_000 }, {
			cwd: process.cwd(),
			signal: controller.signal,
		} as never) as Promise<JobSnapshot>;
		setTimeout(() => controller.abort(), 50);
		assert.equal((await waiting).state, "running");
		assert.ok(Date.now() - begin < 2_000);
	} finally {
		await jobs.close();
	}
});
