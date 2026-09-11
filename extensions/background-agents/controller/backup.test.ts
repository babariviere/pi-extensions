import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { BackgroundAgentsDatabase } from "./database.ts";
import { createSqliteBackup, restoreSqliteBackup } from "./backup.ts";

const directories: string[] = [];
function paths(): { directory: string; databasePath: string } {
	const directory = mkdtempSync(join(tmpdir(), "background-agents-backup-"));
	directories.push(directory);
	return { directory, databasePath: join(directory, "controller.sqlite") };
}
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("background-agents SQLite backups", () => {
	test("takes an online verified snapshot and passes sync argv without interpolation", async () => {
		const { directory, databasePath } = paths();
		const database = new BackgroundAgentsDatabase(databasePath);
		database.createCase({ title: "Snapshot", source: "manual" });
		const seen: string[][] = [];
		const result = await createSqliteBackup({
			databasePath,
			directory,
			retention: 2,
			syncCommand: ["sync-tool", "--target", "name; do not execute"],
			commandRunner: async (argv) => {
				seen.push([...argv]);
			},
			now: () => new Date("2026-01-01T00:00:00Z"),
		});
		database.close();
		assert.equal(result.synchronized, true);
		assert.deepEqual(seen, [["sync-tool", "--target", "name; do not execute"]]);
		assert.match(readFileSync(result.path).subarray(0, 16).toString("ascii"), /^SQLite format 3/);
	});

	test("enforces retention and refuses restore while running while retaining the replaced database", async () => {
		const { directory, databasePath } = paths();
		const database = new BackgroundAgentsDatabase(databasePath);
		const first = await createSqliteBackup({ databasePath, directory, retention: 10 });
		database.close();
		await assert.rejects(
			restoreSqliteBackup({ databasePath, backupPath: first.path, controllerRunning: true }),
			/Cannot restore SQLite backup/,
		);
		const restore = await restoreSqliteBackup({ databasePath, backupPath: first.path, controllerRunning: false });
		assert.ok(restore.replacedPath);
		assert.equal(readFileSync(restore.replacedPath!).subarray(0, 16).toString("ascii"), "SQLite format 3\0");
		const reopened = new BackgroundAgentsDatabase(databasePath);
		reopened.close();
		await createSqliteBackup({ databasePath, directory, retention: 2 });
		await createSqliteBackup({ databasePath, directory, retention: 2 });
		assert.equal(
			readdirSync(directory).filter((name) => name.startsWith("background-agents-") && name.endsWith(".sqlite"))
				.length,
			2,
		);
	});
});
