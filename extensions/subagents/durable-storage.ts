/** Private durable storage with an OS-released, cross-process single-writer lease. */
import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Storage } from "@earendil-works/pi-durable";

const OWNERS = Symbol.for("babariviere.pi-extensions.durable-storage-owners.v1");
function localOwners(): Set<string> {
	const state = globalThis as typeof globalThis & { [key: symbol]: Set<string> | undefined };
	return (state[OWNERS] ??= new Set());
}

function privateFile(file: string): void {
	const fd = openSync(file, constants.O_CREAT | constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
	closeSync(fd);
	if (!lstatSync(file).isFile()) throw new Error(`Durable storage is not a regular file: ${file}`);
	chmodSync(file, 0o600);
}

export async function openDurableStorage(directory: string): Promise<{ storage: Storage; release(): void }> {
	const root = resolve(directory);
	mkdirSync(root, { recursive: true, mode: 0o700 });
	if (!lstatSync(root).isDirectory()) throw new Error(`Durable storage is not a directory: ${root}`);
	chmodSync(root, 0o700);
	const identity = realpathSync(root);
	const owners = localOwners();
	// POSIX SQLite leases are process-wide. Do not open/close a second file
	// descriptor for an owned inode, which could release the first lease.
	if (owners.has(identity)) throw new Error(`Durable subagent storage already has an owner: ${root}`);
	owners.add(identity);
	const lockPath = join(root, "owner.sqlite");
	let lease: DatabaseSync | undefined;
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		try {
			lease?.close();
		} finally {
			owners.delete(identity);
		}
	};
	try {
		privateFile(lockPath);
		lease = new DatabaseSync(lockPath, { timeout: 0 });
		// Hold a separate database transaction for the entire supervisor lifetime.
		// The OS releases it even after SIGKILL; no stale-PID guessing or lockfile deletion.
		lease.exec("BEGIN EXCLUSIVE");
	} catch (error) {
		release();
		throw new Error(`Durable subagent storage already has an owner: ${root}`, { cause: error });
	}
	try {
		const file = join(root, "runs.sqlite");
		privateFile(file);
		const storage = await openNodeSqliteStorage(file);
		return { storage, release };
	} catch (error) {
		release();
		throw error;
	}
}
