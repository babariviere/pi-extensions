/** Synchronous, private job metadata with an OS-released single-owner lease.
 * Logs have no TTL and remain available when their metadata is pruned.
 */
import {
	chmodSync,
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	realpathSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { JobSnapshot } from "./jobs-provider.ts";

export interface PersistedJob {
	snapshot: JobSnapshot;
	claimed: boolean;
}

const OWNERS = Symbol.for("babariviere.pi-extensions.jobs-storage-owners.v1");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATES = new Set(["running", "done", "failed", "cancelled", "interrupted"]);
const FIELDS = new Set([
	"id",
	"name",
	"state",
	"startedAt",
	"endedAt",
	"exitCode",
	"error",
	"outputPath",
	"logTruncated",
]);

function localOwners(): Set<string> {
	const state = globalThis as typeof globalThis & { [key: symbol]: Set<string> | undefined };
	return (state[OWNERS] ??= new Set());
}

function existingFile(path: string): void {
	let stat;
	try {
		stat = lstatSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (!stat.isFile()) throw new Error(`Jobs storage is not a regular file: ${path}`);
}

function privateDirectory(path: string): void {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	if (!lstatSync(path).isDirectory()) throw new Error(`Jobs storage is not a directory: ${path}`);
	chmodSync(path, 0o700);
}

function privateFile(path: string): void {
	existingFile(path);
	const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
	try {
		if (!fstatSync(fd).isFile()) throw new Error(`Jobs storage is not a regular file: ${path}`);
		fchmodSync(fd, 0o600);
	} finally {
		closeSync(fd);
	}
}

function prepareDatabase(path: string): void {
	// SQLite can open these itself, so reject links before it sees them as well.
	for (const suffix of ["-journal", "-wal", "-shm"]) {
		const sidecar = path + suffix;
		existingFile(sidecar);
		try {
			chmodSync(sidecar, 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	privateFile(path);
}

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function timestamp(value: unknown): boolean {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export class JobsStorage {
	readonly directory: string;
	readonly #database: DatabaseSync;
	readonly #lease: DatabaseSync;
	#closed = false;

	private constructor(directory: string, database: DatabaseSync, lease: DatabaseSync) {
		this.directory = directory;
		this.#database = database;
		this.#lease = lease;
	}

	static open(directory: string): JobsStorage {
		const root = resolve(directory);
		privateDirectory(root);
		const identity = realpathSync(root);
		const owners = localOwners();
		// POSIX locks are process-wide. A second open/close of the lease file can
		// release the first owner's lock, so check before opening any descriptor.
		if (owners.has(identity)) throw new Error(`Jobs storage already has an owner: ${identity}`);
		owners.add(identity);
		let lease: DatabaseSync | undefined;
		let database: DatabaseSync | undefined;
		try {
			const leasePath = join(identity, "owner.sqlite");
			prepareDatabase(leasePath);
			lease = new DatabaseSync(leasePath, { timeout: 0 });
			try {
				lease.exec("BEGIN EXCLUSIVE");
			} catch (error) {
				throw new Error(`Jobs storage already has an owner: ${identity}`, { cause: error });
			}
			privateDirectory(join(identity, "logs"));
			const databasePath = join(identity, "jobs.sqlite");
			prepareDatabase(databasePath);
			database = new DatabaseSync(databasePath, { timeout: 0 });
			database.exec(`
				PRAGMA journal_mode = DELETE;
				PRAGMA synchronous = FULL;
				CREATE TABLE IF NOT EXISTS jobs (
					id TEXT PRIMARY KEY NOT NULL,
					snapshot TEXT NOT NULL,
					claimed INTEGER NOT NULL CHECK (claimed IN (0, 1))
				);
			`);
			const storage = new JobsStorage(identity, database, lease);
			storage.load(); // Fail closed, without rewriting or recovering records.
			return storage;
		} catch (error) {
			try {
				database?.close();
			} finally {
				try {
					lease?.close();
				} finally {
					owners.delete(identity);
				}
			}
			throw error;
		}
	}

	#assertOpen(): void {
		if (this.#closed) throw new Error("Jobs storage is closed");
	}

	#outputPath(id: unknown): string {
		if (typeof id !== "string" || !UUID.test(id)) throw new Error("Invalid jobs storage UUID");
		return join(this.directory, "logs", `${id}.log`);
	}

	#validate(value: unknown): PersistedJob {
		if (!object(value) || typeof value.claimed !== "boolean" || !object(value.snapshot))
			throw new Error("Invalid jobs storage record");
		const snapshot = value.snapshot;
		const outputPath = this.#outputPath(snapshot.id);
		if (
			Object.keys(snapshot).some((key) => !FIELDS.has(key)) ||
			typeof snapshot.name !== "string" ||
			!snapshot.name.trim() ||
			typeof snapshot.state !== "string" ||
			!STATES.has(snapshot.state) ||
			!timestamp(snapshot.startedAt) ||
			(snapshot.endedAt !== undefined && !timestamp(snapshot.endedAt)) ||
			(snapshot.exitCode !== undefined && snapshot.exitCode !== null && !Number.isSafeInteger(snapshot.exitCode)) ||
			(snapshot.error !== undefined && typeof snapshot.error !== "string") ||
			(snapshot.logTruncated !== undefined && typeof snapshot.logTruncated !== "boolean") ||
			snapshot.outputPath !== outputPath
		)
			throw new Error("Invalid jobs storage snapshot");
		if (
			(snapshot.state === "running" && (snapshot.endedAt !== undefined || snapshot.exitCode !== undefined)) ||
			(["done", "failed", "interrupted"].includes(snapshot.state) && snapshot.endedAt === undefined) ||
			(snapshot.state === "cancelled" && !value.claimed) ||
			(typeof snapshot.endedAt === "number" && snapshot.endedAt < (snapshot.startedAt as number))
		)
			throw new Error("Invalid jobs storage state");
		// Never stat/chmod/delete an output path supplied by persisted metadata.
		existingFile(outputPath);
		return value as unknown as PersistedJob;
	}

	load(): PersistedJob[] {
		this.#assertOpen();
		this.#checkLogsDirectory();
		const ids = new Set<string>();
		return this.#database
			.prepare("SELECT id, snapshot, claimed FROM jobs ORDER BY rowid")
			.all()
			.map((row) => {
				if (typeof row.snapshot !== "string" || (row.claimed !== 0 && row.claimed !== 1))
					throw new Error("Invalid jobs storage row");
				const record = this.#validate({ snapshot: JSON.parse(row.snapshot), claimed: row.claimed === 1 });
				if (row.id !== record.snapshot.id) throw new Error("Invalid jobs storage row UUID");
				if (ids.has(record.snapshot.id)) throw new Error("Duplicate jobs storage UUID");
				ids.add(record.snapshot.id);
				return record;
			});
	}

	/** Replace the small metadata set in one durable transaction, before caller side effects. */
	save(records: PersistedJob[]): void {
		this.#assertOpen();
		this.#checkLogsDirectory();
		if (!Array.isArray(records)) throw new Error("Invalid jobs storage records");
		const ids = new Set<string>();
		const rows = records.map((record) => {
			const valid = this.#validate(record);
			if (ids.has(valid.snapshot.id)) throw new Error("Duplicate jobs storage UUID");
			ids.add(valid.snapshot.id);
			return { id: valid.snapshot.id, snapshot: JSON.stringify(valid.snapshot), claimed: valid.claimed ? 1 : 0 };
		});
		this.#database.exec("BEGIN IMMEDIATE");
		try {
			this.#database.exec("DELETE FROM jobs");
			const insert = this.#database.prepare("INSERT INTO jobs (id, snapshot, claimed) VALUES (?, ?, ?)");
			for (const row of rows) insert.run(row.id, row.snapshot, row.claimed);
			this.#database.exec("COMMIT");
		} catch (error) {
			this.#database.exec("ROLLBACK");
			throw error;
		}
	}

	#checkLogsDirectory(): void {
		if (!lstatSync(this.directory).isDirectory() || !lstatSync(join(this.directory, "logs")).isDirectory())
			throw new Error("Jobs storage is not a directory");
	}

	createOutput(id: string): { outputPath: string; fd: number } {
		this.#assertOpen();
		this.#checkLogsDirectory();
		const outputPath = this.#outputPath(id);
		const fd = openSync(
			outputPath,
			constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
			0o600,
		);
		try {
			fchmodSync(fd, 0o600);
		} catch (error) {
			closeSync(fd);
			throw error;
		}
		return { outputPath, fd };
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		try {
			this.#database.close();
		} finally {
			try {
				this.#lease.close();
			} finally {
				localOwners().delete(this.directory);
			}
		}
	}
}
