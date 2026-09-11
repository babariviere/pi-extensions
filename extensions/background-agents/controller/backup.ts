import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { backup as sqliteBackup, DatabaseSync } from "node:sqlite";

const execFileAsync = promisify(execFile);

export interface SqliteBackupRuntime {
	snapshot(sourcePath: string, destinationPath: string): Promise<void>;
	integrityCheck(databasePath: string): Promise<void>;
}

export interface BackupCommandRunner {
	(argv: readonly string[]): Promise<void>;
}

export interface BackupOptions {
	databasePath: string;
	directory: string;
	retention: number;
	syncCommand?: readonly string[];
	runtime?: SqliteBackupRuntime;
	commandRunner?: BackupCommandRunner;
	now?: () => Date;
}

export interface BackupResult {
	path: string;
	removed: string[];
	synchronized: boolean;
}

export interface RestoreOptions {
	databasePath: string;
	backupPath: string;
	isControllerRunning?: () => boolean;
	controllerRunning?: boolean | (() => boolean);
	runtime?: Pick<SqliteBackupRuntime, "integrityCheck">;
	now?: () => Date;
}

export interface RestoreResult {
	replacedPath?: string;
	path: string;
}

const defaultRuntime: SqliteBackupRuntime = {
	async snapshot(sourcePath, destinationPath) {
		const source = new DatabaseSync(sourcePath);
		try {
			await sqliteBackup(source, destinationPath);
			// node:sqlite resolves backup before its native handle cleanup reaches the event loop.
			await new Promise<void>((resolve) => setImmediate(resolve));
		} finally {
			source.close();
		}
	},
	async integrityCheck(databasePath) {
		const database = new DatabaseSync(databasePath, { readOnly: true });
		try {
			const result = database.prepare("PRAGMA integrity_check").get() as Record<string, unknown> | undefined;
			const value = result === undefined ? undefined : Object.values(result)[0];
			if (value !== "ok") throw new Error(`SQLite integrity check failed for ${databasePath}: ${String(value)}`);
		} finally {
			database.close();
		}
	},
};

const defaultCommandRunner: BackupCommandRunner = async (argv) => {
	if (argv.length === 0 || !argv[0]) throw new Error("syncCommand must not be empty");
	await execFileAsync(argv[0], argv.slice(1), { shell: false });
};

function timestamp(now: () => Date | undefined): string {
	const value = now() ?? new Date();
	if (Number.isNaN(value.getTime())) throw new Error("now must return a valid date");
	return value.toISOString().replaceAll(/[-:.TZ]/g, "");
}

function checkRetention(retention: number): void {
	if (!Number.isSafeInteger(retention) || retention < 1) throw new Error("retention must be a positive integer");
}

function backupFiles(directory: string): Array<{ path: string; mtimeMs: number }> {
	return readdirSync(directory)
		.filter((name) => name.startsWith("background-agents-") && name.endsWith(".sqlite"))
		.map((name) => {
			const path = `${directory}/${name}`;
			return { path, mtimeMs: statSync(path).mtimeMs };
		})
		.sort((a, b) => b.mtimeMs - a.mtimeMs || b.path.localeCompare(a.path));
}

export async function createSqliteBackup(options: BackupOptions): Promise<BackupResult> {
	checkRetention(options.retention);
	if (!options.databasePath || !options.directory) throw new Error("databasePath and directory are required");
	mkdirSync(options.directory, { recursive: true });
	const path = `${options.directory}/background-agents-${timestamp(options.now ?? (() => new Date()))}-${randomUUID()}.sqlite`;
	const temporaryPath = `${path}.tmp`;
	const runtime = options.runtime ?? defaultRuntime;
	try {
		await runtime.snapshot(options.databasePath, temporaryPath);
		await runtime.integrityCheck(temporaryPath);
		renameSync(temporaryPath, path);
	} catch (error) {
		rmSync(temporaryPath, { force: true });
		throw error;
	}

	let synchronized = false;
	if (options.syncCommand !== undefined) {
		if (options.syncCommand.length === 0 || options.syncCommand.some((argument) => !argument))
			throw new Error("syncCommand must contain a command and non-empty arguments");
		await (options.commandRunner ?? defaultCommandRunner)(options.syncCommand);
		synchronized = true;
	}

	const removed: string[] = [];
	for (const candidate of backupFiles(options.directory).slice(options.retention)) {
		rmSync(candidate.path);
		removed.push(candidate.path);
	}
	return { path, removed, synchronized };
}

export async function restoreSqliteBackup(options: RestoreOptions): Promise<RestoreResult> {
	const controllerIsRunning = () =>
		(typeof options.controllerRunning === "function"
			? options.controllerRunning()
			: options.controllerRunning === true) || options.isControllerRunning?.() === true;
	if (controllerIsRunning()) throw new Error("Cannot restore SQLite backup while the controller is running");
	if (!existsSync(options.backupPath)) throw new Error(`Backup does not exist: ${options.backupPath}`);
	if (options.databasePath === options.backupPath) throw new Error("Backup path must differ from database path");
	const runtime = options.runtime ?? defaultRuntime;
	await runtime.integrityCheck(options.backupPath);
	if (controllerIsRunning()) throw new Error("Cannot restore SQLite backup while the controller is running");

	mkdirSync(options.databasePath.replace(/[/\\][^/\\]*$/, "") || ".", { recursive: true });
	const stamp = timestamp(options.now ?? (() => new Date()));
	const replacedPath = `${options.databasePath}.replaced-${stamp}-${randomUUID()}.sqlite`;
	const temporaryPath = `${options.databasePath}.restore-${randomUUID()}.tmp`;
	const sidecars = ["-wal", "-shm"];
	const movedSidecars: Array<[string, string]> = [];
	let replaced = false;
	try {
		if (existsSync(options.databasePath)) {
			renameSync(options.databasePath, replacedPath);
			replaced = true;
		}
		for (const suffix of sidecars) {
			const source = `${options.databasePath}${suffix}`;
			if (existsSync(source)) {
				const destination = `${replacedPath}${suffix}`;
				renameSync(source, destination);
				movedSidecars.push([source, destination]);
			}
		}
		copyFileSync(options.backupPath, temporaryPath);
		renameSync(temporaryPath, options.databasePath);
	} catch (error) {
		rmSync(temporaryPath, { force: true });
		if (existsSync(options.databasePath) && !replaced) rmSync(options.databasePath, { force: true });
		if (replaced && existsSync(replacedPath)) renameSync(replacedPath, options.databasePath);
		for (const [source, destination] of movedSidecars.reverse()) {
			if (existsSync(destination)) renameSync(destination, source);
		}
		throw error;
	}
	return { path: options.databasePath, replacedPath: replaced ? replacedPath : undefined };
}

export class SqliteBackupManager {
	constructor(private readonly options: BackupOptions) {}

	create(): Promise<BackupResult> {
		return createSqliteBackup(this.options);
	}

	restore(
		backupPath: string,
		options: Omit<RestoreOptions, "databasePath" | "backupPath"> = {},
	): Promise<RestoreResult> {
		return restoreSqliteBackup({ ...options, databasePath: this.options.databasePath, backupPath });
	}
}

export const createBackup = createSqliteBackup;
export const restoreBackup = restoreSqliteBackup;
