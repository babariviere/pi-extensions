import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

export interface Migration {
	version: number;
	name: string;
	sql: string;
}

export const migrationsDirectory = join(import.meta.dirname, "migrations");

function loadMigrations(): Migration[] {
	return readdirSync(migrationsDirectory)
		.filter((name) => /^\d+-.*\.sql$/.test(name))
		.map((name) => {
			const match = /^(\d+)-(.*)\.sql$/.exec(name);
			if (!match) throw new Error(`Invalid migration filename: ${name}`);
			return {
				version: Number(match[1]),
				name: match[2],
				sql: readFileSync(join(migrationsDirectory, name), "utf8"),
			};
		})
		.sort((left, right) => left.version - right.version);
}

export const CURRENT_SCHEMA_VERSION = Math.max(...loadMigrations().map((migration) => migration.version));

function backupBeforeMigration(databasePath: string): void {
	if (databasePath === ":memory:" || databasePath.startsWith("file:")) return;
	if (!existsSync(databasePath)) return;
	const directory = dirname(databasePath);
	mkdirSync(directory, { recursive: true });
	const backupPath = `${databasePath}.pre-migration-${Date.now()}.bak`;
	copyFileSync(databasePath, backupPath);
}

function transaction<T>(database: DatabaseSync, callback: () => T): T {
	if (database.isTransaction) throw new Error("Cannot migrate while a transaction is already active");
	database.exec("BEGIN IMMEDIATE");
	try {
		const result = callback();
		database.exec("COMMIT");
		return result;
	} catch (error) {
		try {
			database.exec("ROLLBACK");
		} catch {
			// Preserve the migration error if rollback itself cannot be performed.
		}
		throw error;
	}
}

export function migrateDatabase(database: DatabaseSync, databasePath = database.location() ?? ":memory:"): void {
	const userVersion = Number((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
	if (userVersion > CURRENT_SCHEMA_VERSION) {
		throw new Error(
			`Background-agents database schema ${userVersion} is newer than the controller schema ${CURRENT_SCHEMA_VERSION}`,
		);
	}

	database.exec(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version INTEGER PRIMARY KEY,
			name TEXT NOT NULL,
			applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		)
	`);
	const applied = database.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all() as Array<{
		version: number;
		name: string;
	}>;
	const knownMigrations = new Map(loadMigrations().map((migration) => [migration.version, migration]));
	for (const migration of applied) {
		if (migration.version > CURRENT_SCHEMA_VERSION) {
			throw new Error(
				`Background-agents database schema ${migration.version} is newer than the controller schema ${CURRENT_SCHEMA_VERSION}`,
			);
		}
		if (knownMigrations.get(migration.version)?.name !== migration.name) {
			throw new Error(`Migration ${migration.version} does not match the controller migration`);
		}
	}
	const appliedVersions = new Set(applied.map((migration) => migration.version));
	const pending = [...knownMigrations.values()].filter((migration) => !appliedVersions.has(migration.version));
	if (pending.length === 0) return;

	database.exec("PRAGMA wal_checkpoint(PASSIVE)");
	backupBeforeMigration(databasePath);
	for (const migration of pending) {
		transaction(database, () => {
			database.exec(migration.sql);
			database
				.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
				.run(migration.version, migration.name);
			database.exec(`PRAGMA user_version = ${migration.version}`);
		});
	}
}
