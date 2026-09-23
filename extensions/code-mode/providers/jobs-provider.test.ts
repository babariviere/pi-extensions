import assert from "node:assert/strict";
import { test } from "node:test";
import { CodeModeJobsProvider, type JobSnapshot } from "./jobs-provider.ts";
import { buildDynamicGuestDeclarations } from "../runtime/dynamic-guest-types.ts";
import { guestTypeDeclarations } from "../runtime/guest-types.ts";
import { typeCheckCodeModeCode } from "../runtime/type-checker.ts";

const context = { cwd: process.cwd() } as never;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const start = (provider: CodeModeJobsProvider, command: string) =>
	provider.invoke("start", { name: "test", command }, context) as Promise<JobSnapshot>;

test("a running job remains running across calls, then wakes only when unclaimed", async () => {
	const sent: JobSnapshot[] = [];
	const jobs = new CodeModeJobsProvider(
		async (command) => command,
		(job) => sent.push(job),
	);
	try {
		const job = await start(jobs, "sleep 0.15; echo completed");
		assert.equal(job.state, "running");
		assert.equal(((await jobs.invoke("wait", { id: job.id, waitMs: 0 }, context)) as JobSnapshot).state, "running");
		assert.equal(((await jobs.invoke("status", {}, context)) as JobSnapshot[])[0]?.state, "running");
		await sleep(450);
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
	const jobs = new CodeModeJobsProvider(
		async (command) => command,
		(job) => sent.push(job),
	);
	try {
		const finished = await start(jobs, "echo claimed");
		assert.equal(((await jobs.invoke("wait", { id: finished.id }, context)) as JobSnapshot).state, "done");
		const stopped = await start(jobs, "sleep 30");
		assert.equal(((await jobs.invoke("stop", { id: stopped.id }, context)) as JobSnapshot).state, "cancelled");
		await sleep(300);
		assert.deepEqual(sent, []);
	} finally {
		await jobs.close();
	}
});

test("sandbox wrapping is applied before launch and rejects unsafe launches", async () => {
	const jobs = new CodeModeJobsProvider(
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
	const jobs = new CodeModeJobsProvider(
		async (command) => command,
		(job) => sent.push(job),
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

test("the jobs namespace exposes typed handles and states to QuickJS programs", async () => {
	const jobs = new CodeModeJobsProvider(
		async (command) => command,
		() => {},
	);
	const actions = await jobs.list({}, context);
	const dynamic = buildDynamicGuestDeclarations({ providers: [{ name: "jobs", actions }] });
	const declarations = guestTypeDeclarations(true, dynamic, ["jobs"]);
	assert.equal(
		typeCheckCodeModeCode(
			"const job = await jobs.start({ name: 'check', command: 'npm test' }); return job.id + job.state;",
			declarations,
		).errors.length,
		0,
	);
	assert.ok(typeCheckCodeModeCode("return await jobs.start({ name: 'check' });", declarations).errors.length > 0);
	await jobs.close();
});
