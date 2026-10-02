import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openDurableStorage } from "./durable-storage.ts";
import { DurableRunBook } from "./durable-run-book.ts";

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

test("SIGKILL releases ownership and committed running work recovers as interrupted, without replay", async () => {
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
		import { DurableRunBook } from ${JSON.stringify(new URL("./durable-run-book.ts", import.meta.url).href)};
		const owned = await openDurableStorage(${JSON.stringify(directory)});
		const book = await DurableRunBook.open(owned.storage);
		await book.register({ runId: "killed", agents: ["task"], promise: new Promise(() => {}), cancel() {} });
		console.log("admitted");
		setInterval(() => {}, 1000);
	`,
		],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	const exited = once(child, "exit");
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += String(chunk);
	});
	try {
		await new Promise<void>((resolve, reject) => {
			child.stdout.once("data", (chunk) => {
				if (String(chunk).trim() === "admitted") resolve();
				else reject(new Error(`Unexpected child output: ${chunk}`));
			});
			child.once("error", reject);
			child.once("exit", () => reject(new Error(`Owner exited before admission: ${stderr}`)));
			timer = setTimeout(() => reject(new Error(`Admission timed out: ${stderr}`)), 10_000);
		});
		clearTimeout(timer);
		child.kill("SIGKILL");
		await exited;
		const owned = await openDurableStorage(directory);
		let book: DurableRunBook | undefined;
		try {
			book = await DurableRunBook.open(owned.storage);
			const recovered = await book.wait("killed", 0);
			assert.equal(recovered.state, "settled");
			assert.equal(recovered.results?.[0]?.ok, false);
			assert.match(recovered.results?.[0]?.error ?? "", /Interrupted by process restart/);
		} finally {
			await book?.close();
			owned.release();
		}
	} finally {
		clearTimeout(timer);
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await exited;
		rmSync(directory, { recursive: true, force: true });
	}
});
