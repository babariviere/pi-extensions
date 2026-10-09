import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { test } from "node:test";
import { JobsProvider, type JobSnapshot } from "./jobs-provider.ts";
import { Value } from "typebox/value";
import { createActionsTool } from "../shared/action-tools.ts";

const context = { cwd: process.cwd() } as never;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const start = (provider: JobsProvider, command: string) =>
	provider.invoke("start", { name: "test", command }, context) as Promise<JobSnapshot>;

async function waitForExit(provider: JobsProvider, id: string): Promise<void> {
	const deadline = Date.now() + 3_000;
	while (Date.now() < deadline) {
		const jobs = (await provider.invoke("status", {}, context)) as JobSnapshot[];
		if (jobs.find((job) => job.id === id)?.endedAt) return;
		await sleep(10);
	}
	assert.fail("Job did not exit in time");
}

test("a running job remains running across calls, then wakes only when unclaimed", async () => {
	const sent: JobSnapshot[] = [];
	let changes = 0;
	const jobs = new JobsProvider(
		async (command) => command,
		(completed) => sent.push(...completed),
		undefined,
		() => changes++,
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
		assert.match(
			String(((await jobs.invoke("logs", { id: job.id }, context)) as { text: string }).text),
			/completed/,
		);
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
		assert.equal(((await jobs.invoke("wait", { id: finished.id }, context)) as JobSnapshot).state, "done");
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

for (const { exitCode, missingOutput } of [
	{ exitCode: 0, missingOutput: false },
	{ exitCode: 7, missingOutput: false },
	{ exitCode: 0, missingOutput: true },
]) {
	test(`terminal logs claim an exit ${exitCode} result during an active turn (missing output: ${missingOutput})`, async () => {
		const sent: JobSnapshot[] = [];
		let idle = false;
		const jobs = new JobsProvider(
			async (command) => command,
			(completed) => sent.push(...completed),
			() => idle,
		);
		try {
			const started = await start(jobs, `echo claimed-through-logs; exit ${exitCode}`);
			await waitForExit(jobs, started.id);
			if (missingOutput) await rm(started.outputPath);
			const result = (await jobs.invoke("logs", { id: started.id }, context)) as JobSnapshot & { text: string };
			assert.equal(result.state, exitCode === 0 ? "done" : "failed");
			assert.equal(result.exitCode, exitCode);
			if (missingOutput) assert.equal(result.text, "");
			else assert.match(result.text, /claimed-through-logs/);
			idle = true;
			jobs.flushCompletions();
			await sleep(250);
			jobs.flushCompletions();
			assert.deepEqual(sent, []);
		} finally {
			await jobs.close();
		}
	});
}

test("reading running logs does not claim a later completion", async () => {
	const sent: JobSnapshot[] = [];
	let idle = false;
	const jobs = new JobsProvider(
		async (command) => command,
		(completed) => sent.push(...completed),
		() => idle,
	);
	try {
		const started = await start(jobs, "sleep 0.3; echo completed-later");
		const result = (await jobs.invoke("logs", { id: started.id }, context)) as JobSnapshot;
		assert.equal(result.state, "running");
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
		const logged = await start(jobs, "echo logged");
		const stopped = await start(jobs, "sleep 30");
		await jobs.invoke("wait", { id: waited.id }, context);
		await jobs.invoke("stop", { id: stopped.id }, context);
		await Promise.all([done, failed, logged].map((job) => waitForExit(jobs, job.id)));
		await jobs.invoke("logs", { id: logged.id }, context);
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
		assert.match(
			String(((await jobs.invoke("logs", { id: started.id }, context)) as { text: string }).text),
			/failure/,
		);
		await sleep(250);
		assert.deepEqual(sent, []);
	} finally {
		await jobs.close();
	}
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
	assert.match(tool.description, /Use bash for short commands and codemode to run independent tool calls in parallel/);
	assert.match(descriptor.description, /long-running shell command only/);
	assert.match(descriptor.description, /codemode to run independent tool calls in parallel/);
	assert.match(tool.namespace?.instructions ?? "", /Use jobs only for long-running shell commands/);
	assert.match(tool.namespace?.instructions ?? "", /codemode with Promise\.allSettled/);
	assert.match(tool.namespace?.instructions ?? "", /Parallelism alone is not a reason to start jobs/);
	assert.doesNotMatch(tool.description + tool.namespace?.instructions, /long-running or parallel/);
	assert.match(tool.description, /instead of polling wait\/logs/);
	assert.match(tool.namespace?.instructions ?? "", /Do not repeatedly call wait, status, or logs/);
	assert.match(actions.find((action) => action.name === "wait")!.description, /only when the next step depends/i);
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
