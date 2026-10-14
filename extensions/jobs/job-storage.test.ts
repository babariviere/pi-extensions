import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmodSync, closeSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { JobsStorage, type PersistedJob } from "./job-storage.ts";

function temporaryDirectory(t: TestContext): string {
	const directory = mkdtempSync(join(tmpdir(), "jobs-storage-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

function record(storage: JobsStorage): PersistedJob {
	const id = randomUUID();
	const { outputPath, fd } = storage.createOutput(id);
	writeFileSync(fd, "retained output\n");
	closeSync(fd);
	return { snapshot: { id, name: "example", state: "running", startedAt: 100, outputPath }, claimed: false };
}

test("metadata and claims survive reopen without recovery or log deletion", (t) => {
	const directory = temporaryDirectory(t);
	const storage = JobsStorage.open(directory);
	const first = record(storage);
	const cancelled = record(storage);
	cancelled.snapshot.state = "cancelled"; // Stop intent need not have an endedAt yet.
	cancelled.claimed = true;
	const interrupted = record(storage);
	Object.assign(interrupted.snapshot, { state: "interrupted", endedAt: 200, exitCode: null, error: "Host exited" });
	const done = record(storage);
	Object.assign(done.snapshot, { state: "done", endedAt: 300, exitCode: 0, logTruncated: true });
	const failed = record(storage);
	Object.assign(failed.snapshot, { state: "failed", endedAt: 300, exitCode: 1 });
	const records = [first, cancelled, interrupted, done, failed];
	try {
		assert.deepEqual(storage.load(), []);
		storage.save(records);
		assert.deepEqual(storage.load(), records);
		done.claimed = true;
		storage.save(records);
	} finally {
		storage.close();
		storage.close();
	}
	const reopened = JobsStorage.open(directory);
	try {
		assert.deepEqual(reopened.load(), records);
		reopened.save([done]);
		assert.deepEqual(reopened.load(), [done]);
		assert.equal(readFileSync(first.snapshot.outputPath, "utf8"), "retained output\n");
		reopened.save([]);
		assert.deepEqual(reopened.load(), []);
		assert.equal(readFileSync(done.snapshot.outputPath, "utf8"), "retained output\n");
	} finally {
		reopened.close();
	}
	assert.throws(() => storage.load(), /closed/);
	assert.throws(() => storage.save([]), /closed/);
	assert.throws(() => storage.createOutput(randomUUID()), /closed/);
});

test("save atomically replaces rows and rolls back a partial failed replacement", (t) => {
	const directory = temporaryDirectory(t);
	const storage = JobsStorage.open(directory);
	t.after(() => storage.close());
	const original = record(storage);
	const replacement = record(storage);
	storage.save([original]);
	const observer = new DatabaseSync(join(directory, "jobs.sqlite"));
	t.after(() => observer.close());
	const readIds = () =>
		observer
			.prepare("SELECT id FROM jobs ORDER BY rowid")
			.all()
			.map((row) => row.id);
	assert.deepEqual(readIds(), [original.snapshot.id]);
	assert.throws(() => storage.save([replacement, replacement]), /Duplicate/);
	const insertedFirst = record(storage);
	// Inject a failure after DELETE and one successful insertion, proving rollback.
	observer.exec(`CREATE TRIGGER fail_insert BEFORE INSERT ON jobs
		WHEN NEW.id = '${replacement.snapshot.id}' BEGIN SELECT RAISE(ABORT, 'injected failure'); END;`);
	assert.throws(() => storage.save([insertedFirst, replacement]), /injected failure/);
	assert.deepEqual(storage.load(), [original]);
	assert.deepEqual(readIds(), [original.snapshot.id]);
	observer.exec("DROP TRIGGER fail_insert");
	storage.save([replacement]);
	assert.deepEqual(readIds(), [replacement.snapshot.id]);
});

test("optional undefined fields are omitted without rejecting valid checkpoints", (t) => {
	const storage = JobsStorage.open(temporaryDirectory(t));
	t.after(() => storage.close());
	const job = record(storage);
	storage.save([{ ...job, snapshot: { ...job.snapshot, endedAt: undefined, exitCode: undefined } }]);
	assert.deepEqual(storage.load(), [job]);
	job.snapshot.state = "done";
	job.snapshot.endedAt = 200;
	storage.save([{ ...job, snapshot: { ...job.snapshot, exitCode: undefined } }]);
	assert.deepEqual(storage.load(), [job]);
	assert.throws(() => storage.save([{ ...job, snapshot: { ...job.snapshot, endedAt: undefined } }]), /state/);
	assert.deepEqual(storage.load(), [job]);
});

test("directories, databases, lease and logs are private", (t) => {
	const directory = temporaryDirectory(t);
	chmodSync(directory, 0o755);
	for (const file of ["jobs.sqlite", "owner.sqlite"]) writeFileSync(join(directory, file), "", { mode: 0o644 });
	const storage = JobsStorage.open(directory);
	t.after(() => storage.close());
	const job = record(storage);
	storage.save([job]);
	for (const path of [directory, join(directory, "logs")]) assert.equal(statSync(path).mode & 0o777, 0o700);
	for (const path of [join(directory, "jobs.sqlite"), join(directory, "owner.sqlite"), job.snapshot.outputPath])
		assert.equal(statSync(path).mode & 0o777, 0o600);
	assert.throws(() => storage.createOutput(job.snapshot.id));
	assert.equal(readFileSync(job.snapshot.outputPath, "utf8"), "retained output\n");
	assert.throws(() => storage.createOutput("../../outside"), /UUID/);
});

test("symlinked final directories, databases, leases, sidecars and log directories fail closed", (t) => {
	const root = temporaryDirectory(t);
	const target = join(root, "target");
	writeFileSync(target, "do not touch", { mode: 0o644 });
	const linkedDirectory = join(root, "linked-directory");
	symlinkSync(root, linkedDirectory);
	assert.throws(() => JobsStorage.open(linkedDirectory), /not a directory/);
	for (const file of ["owner.sqlite", "jobs.sqlite", "owner.sqlite-journal", "jobs.sqlite-wal", "logs"]) {
		const directory = mkdtempSync(join(root, "case-"));
		symlinkSync(target, join(directory, file));
		assert.throws(() => JobsStorage.open(directory));
		assert.throws(() => JobsStorage.open(directory)); // Failure releases the process-local owner.
	}
	assert.equal(readFileSync(target, "utf8"), "do not touch");
	assert.equal(statSync(target).mode & 0o777, 0o644);
});

test("symlinked logs and arbitrary metadata output paths are never followed or modified", (t) => {
	const directory = temporaryDirectory(t);
	const storage = JobsStorage.open(directory);
	t.after(() => storage.close());
	const job = record(storage);
	storage.save([job]);
	const target = join(directory, "outside");
	writeFileSync(target, "secret", { mode: 0o644 });
	assert.throws(() => storage.save([{ ...job, snapshot: { ...job.snapshot, outputPath: target } }]), /Invalid/);
	rmSync(job.snapshot.outputPath);
	symlinkSync(target, job.snapshot.outputPath);
	assert.throws(() => storage.load(), /not a regular file/);
	assert.throws(() => storage.createOutput(job.snapshot.id));
	assert.equal(readFileSync(target, "utf8"), "secret");
	assert.equal(statSync(target).mode & 0o777, 0o644);
});

test("malformed persisted fields, states, IDs, claims and JSON fail closed", (t) => {
	const directory = temporaryDirectory(t);
	let storage = JobsStorage.open(directory);
	const job = record(storage);
	storage.save([job]);
	storage.close();
	const database = new DatabaseSync(join(directory, "jobs.sqlite"));
	t.after(() => database.close());
	const update = database.prepare("UPDATE jobs SET snapshot = ?");
	const invalid = [
		null,
		[],
		{},
		{ ...job.snapshot, id: "not-a-uuid" },
		{ ...job.snapshot, name: 5 },
		{ ...job.snapshot, name: " " },
		{ ...job.snapshot, state: "unknown" },
		{ ...job.snapshot, state: "done" },
		{ ...job.snapshot, state: "failed" },
		{ ...job.snapshot, state: "interrupted" },
		{ ...job.snapshot, state: "cancelled" }, // Cancellation intent must be claimed.
		{ ...job.snapshot, endedAt: 200 }, // Running cannot already have settled.
		{ ...job.snapshot, exitCode: null },
		{ ...job.snapshot, state: "done", endedAt: 50 },
		{ ...job.snapshot, startedAt: "100" },
		{ ...job.snapshot, endedAt: null },
		{ ...job.snapshot, exitCode: 1.5 },
		{ ...job.snapshot, error: false },
		{ ...job.snapshot, logTruncated: "yes" },
		{ ...job.snapshot, outputPath: "/outside/log" },
		{ ...job.snapshot, command: "not persisted" },
	];
	for (const snapshot of invalid) {
		update.run(JSON.stringify(snapshot));
		assert.throws(() => JobsStorage.open(directory), /Invalid/);
	}
	update.run("not JSON");
	assert.throws(() => JobsStorage.open(directory), SyntaxError);
	update.run(JSON.stringify(job.snapshot));
	database.exec("PRAGMA ignore_check_constraints = ON; UPDATE jobs SET claimed = 2;");
	assert.throws(() => JobsStorage.open(directory), /Invalid/);
	database.exec("UPDATE jobs SET claimed = 0;");
	storage = JobsStorage.open(directory);
	try {
		assert.deepEqual(storage.load(), [job]);
		for (const field of ["startedAt", "endedAt", "exitCode"])
			assert.throws(() => storage.save([{ ...job, snapshot: { ...job.snapshot, [field]: Infinity } }]), /Invalid/);
		assert.throws(() => storage.save([{ ...job, claimed: "false" } as unknown as PersistedJob]), /Invalid/);
		assert.deepEqual(storage.load(), [job]);
	} finally {
		storage.close();
	}
});

test("same-process duplicate owners cannot release the cross-process lease", async (t) => {
	const directory = temporaryDirectory(t);
	const storage = JobsStorage.open(directory);
	t.after(() => storage.close());
	assert.throws(() => JobsStorage.open(join(directory, ".")), /already has an owner/);
	const { stdout } = await promisify(execFile)(process.execPath, [
		"--import",
		"tsx",
		"--input-type=module",
		"-e",
		`
		import { JobsStorage } from ${JSON.stringify(new URL("./job-storage.ts", import.meta.url).href)};
		try {
			const storage = JobsStorage.open(${JSON.stringify(directory)});
			storage.close(); console.log("unexpected owner");
		} catch (error) {
			if (!error.message.includes("already has an owner")) throw error;
			console.log("locked");
		}
		`,
	]);
	assert.equal(stdout.trim(), "locked");
	storage.close();
	const reopened = JobsStorage.open(directory);
	reopened.close();
});

test("SIGKILL releases the owner lease and preserves only committed metadata", async (t) => {
	const directory = temporaryDirectory(t);
	const id = randomUUID();
	const child = spawn(
		process.execPath,
		[
			"--import",
			"tsx",
			"--input-type=module",
			"-e",
			`
		import { closeSync, writeFileSync } from "node:fs";
		import { DatabaseSync } from "node:sqlite";
		import { JobsStorage } from ${JSON.stringify(new URL("./job-storage.ts", import.meta.url).href)};
		const storage = JobsStorage.open(${JSON.stringify(directory)});
		const { outputPath, fd } = storage.createOutput(${JSON.stringify(id)});
		writeFileSync(fd, "committed log"); closeSync(fd);
		storage.save([{ snapshot: { id: ${JSON.stringify(id)}, name: "survives",
			state: "running", startedAt: 100, outputPath }, claimed: false }]);
		const database = new DatabaseSync(${JSON.stringify(join(directory, "jobs.sqlite"))});
		database.exec("BEGIN IMMEDIATE; DELETE FROM jobs;");
		console.log("ready");
		setInterval(() => {}, 1000);
	`,
		],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	const exited = once(child, "close");
	void exited.catch(() => {});
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += String(chunk);
	});
	try {
		await new Promise<void>((resolve, reject) => {
			let stdout = "";
			child.stdout.on("data", (chunk) => {
				stdout += String(chunk);
				if (stdout.includes("ready\n")) resolve();
			});
			child.once("error", reject);
			child.once("exit", () => reject(new Error(`Owner exited before ready: ${stderr}`)));
			timer = setTimeout(() => reject(new Error(`Owner timed out: ${stderr}`)), 10_000);
		});
		clearTimeout(timer);
		assert.throws(() => JobsStorage.open(directory), /already has an owner/);
		child.kill("SIGKILL");
		const [code, signal] = await exited;
		assert.equal(code, null);
		assert.equal(signal, "SIGKILL");
		const storage = JobsStorage.open(directory);
		try {
			const records = storage.load();
			assert.equal(records.length, 1);
			assert.equal(records[0].snapshot.id, id);
			assert.equal(records[0].snapshot.state, "running");
			assert.equal(records[0].claimed, false);
			assert.equal(readFileSync(records[0].snapshot.outputPath, "utf8"), "committed log");
			records[0].claimed = true;
			storage.save(records);
			assert.equal(storage.load()[0].claimed, true);
		} finally {
			storage.close();
		}
	} finally {
		clearTimeout(timer);
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await exited;
	}
});
