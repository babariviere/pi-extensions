import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSession, defineDoc } from "@earendil-works/pi-durable";
import { openDurableStorage } from "./durable-storage.ts";

const Journal = defineDoc<{ sequence: number; entries: string[] }>({
	kind: "subagents.storage-test-journal",
	version: 1,
	scope: "session",
	initial: () => ({ sequence: 0, entries: [] }),
});

test("durable storage is private and refuses a second writer, including another process", async () => {
	const directory = mkdtempSync(join(tmpdir(), "durable-storage-"));
	const owned = await openDurableStorage(directory);
	try {
		assert.equal(statSync(directory).mode & 0o777, 0o700);
		assert.equal(statSync(join(directory, "runs.sqlite")).mode & 0o777, 0o600);
		await assert.rejects(openDurableStorage(directory), /already has an owner/);
		const { stdout } = await promisify(execFile)(process.execPath, [
			"--input-type=module",
			"-e",
			`
			import { DatabaseSync } from "node:sqlite";
			const db = new DatabaseSync(${JSON.stringify(join(directory, "owner.sqlite"))}, { timeout: 0 });
			try { db.exec("BEGIN EXCLUSIVE"); console.log("unexpected owner"); }
			catch { console.log("locked"); }
			finally { db.close(); }
		`,
		]);
		assert.equal(stdout.trim(), "locked");
	} finally {
		await owned.storage.close(BACKGROUND_CONTEXT);
		owned.release();
		owned.release();
	}
	try {
		const reopened = await openDurableStorage(directory);
		await reopened.storage.close(BACKGROUND_CONTEXT);
		reopened.release();
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("durable storage rejects symlinked directories and database files", async () => {
	const root = mkdtempSync(join(tmpdir(), "durable-symlink-"));
	try {
		const target = join(root, "target");
		writeFileSync(target, "do not touch");
		symlinkSync(root, join(root, "link"));
		await assert.rejects(openDurableStorage(join(root, "link")), /not a directory/);
		symlinkSync(target, join(root, "owner.sqlite"));
		await assert.rejects(openDurableStorage(root));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("SIGKILL releases the OS owner lease and preserves committed session journal data", async () => {
	const directory = mkdtempSync(join(tmpdir(), "durable-killed-owner-"));
	const child = spawn(
		process.execPath,
		[
			"--import",
			"tsx",
			"--input-type=module",
			"-e",
			`
		import { openDurableStorage } from ${JSON.stringify(new URL("./durable-storage.ts", import.meta.url).href)};
		import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
		import { createSession, defineDoc } from "@earendil-works/pi-durable";
		const owned = await openDurableStorage(${JSON.stringify(directory)});
		const session = createSession(owned.storage);
		const Journal = defineDoc({
			kind: ${JSON.stringify(Journal.definition.kind)}, version: 1, scope: "session",
			initial: () => ({ sequence: 0, entries: [] }),
		});
		for (let sequence = 1; sequence <= 3; sequence++) {
			await session.commit(async (tx) => {
				const journal = await tx.doc(Journal);
				journal.sequence = sequence;
				journal.entries.push("committed-" + sequence);
			}, BACKGROUND_CONTEXT);
		}
		console.log("committed");
		// Leave an in-memory draft open to prove only committed writes survive SIGKILL.
		void session.commit(async (tx) => {
			const journal = await tx.doc(Journal);
			journal.sequence = 4;
			journal.entries.push("uncommitted");
			console.log("draft");
			await new Promise(() => {});
		}, BACKGROUND_CONTEXT);
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
				if (stdout.includes("committed\n") && stdout.includes("draft\n")) resolve();
			});
			child.once("error", reject);
			child.once("exit", () => reject(new Error(`Owner exited before commit: ${stderr}`)));
			timer = setTimeout(() => reject(new Error(`Commit timed out: ${stderr}`)), 10_000);
		});
		clearTimeout(timer);
		await assert.rejects(openDurableStorage(directory), /already has an owner/);
		child.kill("SIGKILL");
		const [code, signal] = await exited;
		assert.equal(code, null);
		assert.equal(signal, "SIGKILL");
		const owned = await openDurableStorage(directory);
		const session = createSession(owned.storage);
		try {
			assert.deepEqual(await session.snapshot(Journal, BACKGROUND_CONTEXT), {
				sequence: 3,
				entries: ["committed-1", "committed-2", "committed-3"],
			});
			await session.commit(async (tx) => {
				const journal = await tx.doc(Journal);
				journal.sequence++;
				journal.entries.push("new-owner");
			}, BACKGROUND_CONTEXT);
			assert.deepEqual(await session.snapshot(Journal, BACKGROUND_CONTEXT), {
				sequence: 4,
				entries: ["committed-1", "committed-2", "committed-3", "new-owner"],
			});
		} finally {
			try {
				await session.close(BACKGROUND_CONTEXT);
			} finally {
				owned.release();
			}
		}
	} finally {
		clearTimeout(timer);
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await exited;
		rmSync(directory, { recursive: true, force: true });
	}
});
