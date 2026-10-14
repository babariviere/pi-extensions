import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquireJobs, closeJobs, jobsDirectory, type JobsSession } from "./job-owners.ts";
import { JobsStorage } from "./job-storage.ts";

test("reload owners use canonical parent directory identity across filesystem aliases", async () => {
	const root = await mkdtemp(join(tmpdir(), "jobs-owner-alias-"));
	const alias = `${root}-alias`;
	await symlink(root, alias);
	const ref: JobsSession = { cwd: root, sessionId: "parent", sessionFile: join(root, "session.jsonl") };
	const alternate = { ...ref, sessionFile: join(alias, "session.jsonl") };
	try {
		assert.equal(jobsDirectory(ref), jobsDirectory(alternate));
		assert.equal(await acquireJobs(ref, {}), await acquireJobs(alternate, {}));
		await closeJobs(alternate);
		const journal = JobsStorage.open(jobsDirectory(ref)!);
		journal.close();
	} finally {
		await closeJobs(ref);
		await rm(alias, { force: true });
		await rm(root, { recursive: true, force: true });
	}
});

test("startup superseded while awaiting an outgoing close cannot create an orphan owner", async () => {
	const root = await mkdtemp(join(tmpdir(), "jobs-owner-startup-"));
	const ref: JobsSession = { cwd: root, sessionId: "parent", sessionFile: join(root, "session.jsonl") };
	try {
		await acquireJobs(ref, {});
		const closing = closeJobs(ref);
		let current = true;
		const pending = acquireJobs(ref, {}, () => current);
		current = false;
		await assert.rejects(pending, /superseded/);
		await closing;
		const journal = JobsStorage.open(jobsDirectory(ref)!);
		journal.close();
	} finally {
		await closeJobs(ref);
		await rm(root, { recursive: true, force: true });
	}
});
