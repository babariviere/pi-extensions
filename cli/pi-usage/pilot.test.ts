import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { scanSources } from "./index.ts";
import { databaseSession, scanPilot } from "./pilot.ts";
import { buildReport } from "./report.ts";

const assistant = (responseId: string, cost: number, timestamp = Date.parse("2026-10-12T10:00:00Z")) => ({
	role: "assistant",
	provider: "anthropic",
	model: "claude-test",
	responseId,
	timestamp,
	usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 20, cost: { total: cost } },
});

function database(path: string, records: unknown[]): void {
	mkdirSync(join(path, ".."), { recursive: true });
	const db = new DatabaseSync(path);
	db.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, record TEXT NOT NULL)");
	const insert = db.prepare("INSERT INTO entries (id, conversation_id, record) VALUES (?, 1, ?)");
	for (const [index, record] of records.entries()) insert.run(index + 1, JSON.stringify(record));
	db.close();
}

function pilotHome(t: { after(fn: () => void): void }): string {
	const home = mkdtempSync(join(tmpdir(), "pi-usage-pilot-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	writeFileSync(join(home, "projects.json"), JSON.stringify([{ id: "project-1", name: "repo", path: "/src/repo" }]));
	const session = join(home, "sessions", "session-1");
	mkdirSync(session, { recursive: true });
	writeFileSync(
		join(session, "meta.json"),
		JSON.stringify({ id: "session-1", title: "Fix the bug", projectId: "project-1", cwd: `${session}/workspace` }),
	);
	database(join(session, "durable", "harness.sqlite"), [
		{ kind: "pi.user", model: [{ role: "user", content: "hi", timestamp: 1 }] },
		{ kind: "pi.assistant", model: [assistant("response-1", 1.5)] },
		{
			kind: "pi.tool-result",
			model: [{ role: "toolResult", toolName: "agents_run", timestamp: 2, usage: { input: 3, cost: 0.25 } }],
		},
		"not an object",
	]);
	database(join(session, "durable", "subagent-runs", "session-1", "run-1", "review.durable", "runs.sqlite"), [
		{ kind: "pi.assistant", model: [assistant("response-2", 0.5)] },
		// Copied from the parent; counted once.
		{ kind: "pi.assistant", model: [assistant("response-1", 1.5)] },
	]);
	return home;
}

test("scanPilot reads harness and subagent databases with project and title attribution", async (t) => {
	const home = pilotHome(t);
	const result = await scanPilot(home);
	assert.equal(result.pilotDatabases, 2);
	assert.equal(result.unreadableDatabases, 0);
	assert.equal(result.duplicateRecords, 1);
	assert.deepEqual(
		result.records.map(({ origin, sessionId, project, sessionTitle, provider, model, cost }) => [
			origin,
			sessionId,
			project,
			sessionTitle,
			provider,
			model,
			cost,
		]),
		[
			["pilot", "session-1", "repo", "Fix the bug", "anthropic", "claude-test", 1.5],
			["pilot", "session-1", "repo", "Fix the bug", "tool", "agents_run", 0.25],
			["pilot", "run-1", "repo", "review", "anthropic", "claude-test", 0.5],
		],
	);
	const report = buildReport(result, { kind: "session", timezone: "UTC", sessionsDir: "/unused" });
	assert.deepEqual(
		report.rows.map(({ label, totalCost }) => [label, totalCost]),
		[
			["repo · Fix the bug", 1.75],
			["repo · review", 0.5],
		],
	);
});

test("scanPilot tolerates a missing Pilot home", async () => {
	const result = await scanPilot(join(tmpdir(), "pi-usage-missing-pilot-home"));
	assert.equal(result.records.length, 0);
	assert.equal(result.pilotDatabases, 0);
});

test("scanSources combines pi and Pilot stores and deduplicates responses across them", async (t) => {
	const home = pilotHome(t);
	const sessionsDir = mkdtempSync(join(tmpdir(), "pi-usage-pi-"));
	t.after(() => rmSync(sessionsDir, { recursive: true, force: true }));
	writeFileSync(
		join(sessionsDir, "session.jsonl"),
		[
			{ type: "session", id: "pi-session", cwd: "/src/other" },
			{ type: "message", id: "a", message: assistant("response-1", 1.5) },
			{ type: "message", id: "b", message: assistant("response-3", 2) },
		]
			.map((entry) => JSON.stringify(entry))
			.join("\n"),
	);
	const all = await scanSources({ source: "all", sessionsDir, pilotDir: home });
	assert.equal(all.files, 1);
	assert.equal(all.pilotDatabases, 2);
	assert.equal(all.duplicateRecords, 2);
	assert.equal(
		all.records.reduce((sum, record) => sum + (record.cost ?? 0), 0),
		1.5 + 2 + 0.25 + 0.5,
	);
	const pilotOnly = await scanSources({ source: "pilot", sessionsDir, pilotDir: home });
	assert.equal(pilotOnly.files, 0);
	assert.ok(pilotOnly.records.every((record) => record.origin === "pilot"));
	const piOnly = await scanSources({ source: "pi", sessionsDir, pilotDir: home });
	assert.equal(piOnly.pilotDatabases, undefined);
	assert.ok(piOnly.records.every((record) => record.origin === "pi"));
});

test("databaseSession attributes nested stores", () => {
	const meta = { id: "parent", title: "Parent", project: "repo" };
	assert.deepEqual(databaseSession("/d", "/d/harness.sqlite", meta), { id: "parent", title: "Parent" });
	assert.deepEqual(databaseSession("/d", "/d/subagent-runs/parent/run/name.durable/runs.sqlite", meta), {
		id: "run",
		title: "name",
	});
	assert.deepEqual(databaseSession("/d", "/d/native.session.subagents-durable/abc/runs.sqlite", meta), {
		id: "parent:native.session.subagents-durable/abc",
		title: "Parent",
	});
});
