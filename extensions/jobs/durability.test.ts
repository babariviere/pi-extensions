import assert from "node:assert/strict";
import childProcess, { spawn } from "node:child_process";
import { once } from "node:events";
import { closeSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { JobsStorage } from "./job-storage.ts";
import { JobsProvider, type JobSnapshot } from "./jobs-provider.ts";

const context = { cwd: process.cwd() } as never;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const start = (jobs: JobsProvider, command: string) =>
	jobs.invoke("start", { name: "test", command }, context) as Promise<JobSnapshot>;

test("a killed host recovers unfinished jobs as interrupted without executing them again", {
	timeout: 15_000,
}, async () => {
	const directory = await mkdtemp(join(tmpdir(), "jobs-crash-"));
	const counter = join(directory, "effects");
	const storagePath = join(directory, "journal");
	const child = spawn(
		process.execPath,
		[
			"--import",
			"tsx",
			"--input-type=module",
			"-e",
			`
		import { JobsProvider } from ${JSON.stringify(new URL("./jobs-provider.ts", import.meta.url).href)};
		import { JobsStorage } from ${JSON.stringify(new URL("./job-storage.ts", import.meta.url).href)};
		const jobs = new JobsProvider(async command => command, () => {}, () => false, undefined, {}, JobsStorage.open(${JSON.stringify(storagePath)}));
		const job = await jobs.invoke("start", { name: "crash", command: ${JSON.stringify(`echo effect >> ${JSON.stringify(counter)}; echo progress; sleep 1; echo finished`)} }, { cwd: ${JSON.stringify(process.cwd())} });
		process.stdout.write(JSON.stringify(job) + "\\n");
		setInterval(() => {}, 1000);
	`,
		],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	let jobs: JobsProvider | undefined;
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const exited = once(child, "exit");
	try {
		const line = await new Promise<string>((resolve, reject) => {
			let output = "";
			child.stdout.on("data", (chunk) => {
				output += chunk;
				if (output.includes("\n")) resolve(output.split("\n")[0]!);
			});
			child.on("error", reject);
			child.on("exit", () => reject(new Error(`Host exited before admission: ${stderr}`)));
		});
		const admitted = JSON.parse(line) as JobSnapshot;
		const deadline = Date.now() + 5_000;
		while (!(await readFile(counter, "utf8").catch(() => "")) && Date.now() < deadline) await sleep(10);
		assert.equal(await readFile(counter, "utf8"), "effect\n");
		child.kill("SIGKILL");
		await exited;
		const notifications: JobSnapshot[] = [];
		jobs = new JobsProvider(
			async () => {
				assert.fail("Recovery must not wrap or launch a command");
			},
			(batch) => notifications.push(...batch),
			() => false,
			undefined,
			{},
			JobsStorage.open(storagePath),
		);
		const [recovered] = (await jobs.invoke("list", {}, context)) as JobSnapshot[];
		assert.equal(recovered?.id, admitted.id);
		assert.equal(recovered?.state, "interrupted");
		assert.equal(recovered?.exitCode, null);
		assert.match(recovered?.error ?? "", /side effects.*not rerun/);
		assert.equal(recovered?.outputPath, admitted.outputPath);
		assert.ok(await stat(admitted.outputPath));
		jobs.canAnnounce = () => true;
		jobs.flushCompletions();
		assert.deepEqual(
			notifications.map((job) => job.id),
			[admitted.id],
		);
		await jobs.close();
		jobs = new JobsProvider(
			async () => {
				assert.fail("Recovery must not execute");
			},
			(batch) => notifications.push(...batch),
			() => true,
			undefined,
			{},
			JobsStorage.open(storagePath),
		);
		jobs.flushCompletions();
		assert.equal(notifications.length, 1, "the notification receipt survived reopening");
		await sleep(1_200); // Let the deliberately orphaned shell finish before removing its directory.
		assert.equal(await readFile(counter, "utf8"), "effect\n");
	} finally {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await exited;
		await jobs?.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("storage failure refuses admission before shell effects and never falls back to memory", async () => {
	const directory = await mkdtemp(join(tmpdir(), "jobs-storage-failure-"));
	const storage = JobsStorage.open(join(directory, "journal"));
	const jobs = new JobsProvider(
		async (command) => command,
		() => {},
		() => false,
		undefined,
		{},
		storage,
	);
	const effect = join(directory, "effect");
	const errors: Error[] = [];
	jobs.onError = (error) => errors.push(error);
	storage.save = () => {
		throw new Error("disk full");
	};
	try {
		await assert.rejects(start(jobs, `echo unsafe > ${JSON.stringify(effect)}`), /Jobs storage failed/);
		await assert.rejects(stat(effect), { code: "ENOENT" });
		assert.deepEqual(await jobs.invoke("list", {}, context), []);
		assert.equal(errors.length, 1);
		await assert.rejects(start(jobs, "echo another"), /new launches.*disabled/);
	} finally {
		await jobs.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("a failed notification consumes its durable receipt but preserves result and log", async () => {
	const directory = await mkdtemp(join(tmpdir(), "jobs-receipt-"));
	let storage = JobsStorage.open(directory);
	let deliveries = 0;
	let jobs = new JobsProvider(
		async (command) => command,
		() => {
			deliveries++;
			throw new Error("delivery failed");
		},
		() => false,
		undefined,
		{},
		storage,
	);
	try {
		const job = await start(jobs, "echo retained");
		const deadline = Date.now() + 5_000;
		while (!storage.load()[0]?.snapshot.endedAt && Date.now() < deadline) await sleep(10);
		assert.equal(storage.load()[0]?.snapshot.state, "done");
		jobs.canAnnounce = () => true;
		jobs.flushCompletions();
		assert.equal(deliveries, 1);
		await jobs.close();
		storage = JobsStorage.open(directory);
		jobs = new JobsProvider(
			async (command) => command,
			() => {
				deliveries++;
			},
			() => true,
			undefined,
			{},
			storage,
		);
		jobs.flushCompletions();
		assert.equal(deliveries, 1);
		assert.equal(((await jobs.invoke("list", {}, context)) as JobSnapshot[])[0]?.id, job.id);
		assert.match(await readFile(job.outputPath, "utf8"), /retained/);
	} finally {
		await jobs.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("cancelled admission intent is recovered as cancelled, not reclassified or announced", async () => {
	const directory = await mkdtemp(join(tmpdir(), "jobs-cancel-intent-"));
	const storage = JobsStorage.open(directory);
	const id = "38ae3f03-f1aa-4af1-bd1a-6e0f08b39e20";
	const output = storage.createOutput(id);
	closeSync(output.fd);
	storage.save([
		{
			snapshot: { id, name: "stopped", state: "cancelled", startedAt: Date.now(), outputPath: output.outputPath },
			claimed: true,
		},
	]);
	storage.close();
	const jobs = new JobsProvider(
		async () => {
			assert.fail("No launch during recovery");
		},
		() => {
			assert.fail("Stopped jobs do not notify");
		},
		() => true,
		undefined,
		{},
		JobsStorage.open(directory),
	);
	try {
		jobs.flushCompletions();
		const result = (await jobs.invoke("wait", { id }, context)) as JobSnapshot;
		assert.equal(result.state, "cancelled");
		assert.ok(result.endedAt);
	} finally {
		await jobs.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("a completion checkpoint failure disables acknowledgements but leaves live status readable", async () => {
	const directory = await mkdtemp(join(tmpdir(), "jobs-completion-failure-"));
	const storage = JobsStorage.open(directory);
	const errors: Error[] = [];
	let deliveries = 0;
	const jobs = new JobsProvider(
		async (command) => command,
		() => {
			deliveries++;
		},
		() => false,
		undefined,
		{},
		storage,
	);
	jobs.onError = (error) => errors.push(error);
	try {
		const job = await start(jobs, "sleep 0.1; echo complete");
		storage.save = () => {
			throw new Error("checkpoint failed");
		};
		await assert.rejects(jobs.invoke("wait", { id: job.id }, context), /completion acknowledgements are disabled/);
		assert.equal(errors.length, 1);
		assert.equal(((await jobs.invoke("list", {}, context)) as JobSnapshot[])[0]?.state, "done");
		assert.equal(storage.load()[0]?.snapshot.state, "running", "only the admission was committed");
		jobs.canAnnounce = () => true;
		jobs.flushCompletions();
		assert.equal(deliveries, 0);
		await assert.rejects(start(jobs, "echo another"), /Jobs storage failed/);
	} finally {
		await jobs.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("synchronous spawn failure settles the admitted record and remains queryable after restart", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "jobs-spawn-failure-"));
	let jobs = new JobsProvider(
		async (command) => command,
		() => {},
		() => false,
		undefined,
		{},
		JobsStorage.open(directory),
	);
	const mocked = t.mock.method(childProcess, "spawn", () => {
		throw new Error("injected spawn failure");
	});
	syncBuiltinESMExports();
	try {
		await assert.rejects(start(jobs, "echo not-started"), /injected spawn failure/);
		const [failed] = (await jobs.invoke("list", {}, context)) as JobSnapshot[];
		assert.equal(failed?.state, "failed");
		assert.equal(failed?.exitCode, null);
		assert.equal(jobs.running().length, 0);
		assert.ok(failed?.endedAt);
		assert.match(failed?.error ?? "", /injected spawn failure/);
		assert.equal(((await jobs.invoke("wait", { id: failed!.id }, context)) as JobSnapshot).state, "failed");
		await jobs.close();
		jobs = new JobsProvider(
			async (command) => command,
			() => {},
			() => false,
			undefined,
			{},
			JobsStorage.open(directory),
		);
		assert.deepEqual(await jobs.invoke("list", {}, context), [failed]);
	} finally {
		mocked.mock.restore();
		syncBuiltinESMExports();
		await jobs.close();
		await rm(directory, { recursive: true, force: true });
	}
});
