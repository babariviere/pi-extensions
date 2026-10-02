import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildReport } from "./report.ts";
import { scanSessions } from "./scanner.ts";

const session = (id: string, cwd: string) =>
	JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-21T10:00:00.000Z", cwd });

const assistant = (id: string, responseId: string, cost: number) =>
	JSON.stringify({
		type: "message",
		id,
		timestamp: "2026-09-21T10:01:00.000Z",
		message: {
			role: "assistant",
			provider: "openai-codex",
			model: "gpt-test",
			responseId,
			usage: {
				input: 100,
				output: 20,
				cacheRead: 500,
				cacheWrite: 10,
				cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: cost },
			},
		},
	});

test("recursively scans parent and subagent sessions and deduplicates copied responses", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-usage-scan-"));
	const project = join(root, "project");
	const child = join(project, "subagent-runs", "parent", "run");
	mkdirSync(child, { recursive: true });
	writeFileSync(
		join(project, "parent.jsonl"),
		`${session("parent", "/repo/project")}\n${assistant("a", "response-1", 9)}\n`,
	);
	writeFileSync(
		join(child, "worker.session.jsonl"),
		`${session("child", "/repo/project")}\n${assistant("b", "response-1", 9)}\n${assistant("c", "response-2", 7)}\n`,
	);

	const result = await scanSessions(root);
	assert.equal(result.files, 2);
	assert.equal(result.records.length, 2);
	assert.equal(result.duplicateRecords, 1);
	assert.deepEqual(result.records.map((record) => record.cost).sort(), [7, 9]);
	assert.ok(result.records.every((record) => record.project === "project"));
});

test("uses cost components when total is absent and reports missing costs", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-usage-cost-"));
	mkdirSync(join(root, "project"), { recursive: true });
	const componentCost = JSON.parse(assistant("a", "one", 1));
	delete componentCost.message.usage.cost.total;
	const noCost = JSON.parse(assistant("b", "two", 1));
	delete noCost.message.usage.cost;
	writeFileSync(
		join(root, "project", "session.jsonl"),
		[session("session", "/repo/project"), JSON.stringify(componentCost), JSON.stringify(noCost)].join("\n"),
	);

	const result = await scanSessions(root);
	assert.equal(result.records[0]?.cost, 10);
	assert.equal(result.records[1]?.cost, undefined);
});

test("counts tool, usage, compaction, and branch-summary usage without model misattribution", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-usage-kinds-"));
	const project = join(root, "project");
	mkdirSync(project, { recursive: true });
	const entries = [
		session("parent", "/repo/project"),
		JSON.stringify({
			type: "message",
			id: "tool-result",
			timestamp: "2026-09-21T10:02:00.000Z",
			message: { role: "toolResult", toolName: "agents_run", usage: { input: 12, output: 4, cost: { total: 0.3 } } },
		}),
		JSON.stringify({
			type: "usage",
			id: "usage-entry",
			timestamp: "2026-09-21T10:03:00.000Z",
			kind: "future_kind",
			provider: "provider",
			model: "model",
			usage: { input: 5, output: 1, cost: { total: 0.2 } },
		}),
		JSON.stringify({
			type: "compaction",
			id: "compaction-entry",
			timestamp: "2026-09-21T10:04:00.000Z",
			usage: { input: 7, output: 2, cost: { total: 0.1 } },
		}),
		JSON.stringify({
			type: "branch_summary",
			id: "branch-entry",
			timestamp: "2026-09-21T10:05:00.000Z",
			usage: { input: 3, output: 1, cost: { total: 0.05 } },
		}),
	];
	writeFileSync(join(project, "parent.jsonl"), entries.join("\n"));

	const result = await scanSessions(root);
	assert.equal(result.records.length, 4);
	assert.deepEqual(
		result.records.map(({ usageSource }) => usageSource),
		["tool", "usage", "compaction", "branch_summary"],
	);
	assert.deepEqual(
		result.records[0] && [result.records[0].provider, result.records[0].model, result.records[0].cost],
		["tool", "agents_run", 0.3],
	);
	assert.equal(result.records[1]?.usageKind, "future_kind");
	const report = buildReport(result, { kind: "session", timezone: "UTC", sessionsDir: root });
	assert.equal(report.totals.inputTokens, 27);
	assert.equal(report.totals.outputTokens, 8);
	assert.equal(report.totals.totalCost, 0.65);
});

test("deduplicates cloned usage entries and keeps child-session usage in its own session row", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-usage-cloned-entry-"));
	const project = join(root, "project");
	const child = join(project, "subagent-runs", "parent", "run");
	mkdirSync(child, { recursive: true });
	const clonedUsage = JSON.stringify({
		type: "usage",
		id: "branch-cloned-usage",
		timestamp: "2026-09-21T10:03:00.000Z",
		kind: "unrecognized",
		provider: "provider",
		model: "model",
		usage: { input: 20, output: 5, cost: { total: 0.7 } },
	});
	writeFileSync(join(project, "parent.jsonl"), `${session("parent", "/repo/project")}\n${clonedUsage}\n`);
	writeFileSync(
		join(child, "worker.session.jsonl"),
		`${session("child", "/repo/project")}\n${clonedUsage}\n${assistant("child-response", "child-response", 0.4)}\n`,
	);

	const result = await scanSessions(root);
	assert.equal(result.duplicateRecords, 1);
	const report = buildReport(result, { kind: "session", timezone: "UTC", sessionsDir: root });
	assert.deepEqual(
		report.rows.map(({ key, totalCost }) => [key, totalCost]),
		[
			["child", 0.4],
			["parent", 0.7],
		],
	);
	assert.equal(report.totals.totalCost, 1.1);
});

test("independent non-assistant usage with colliding short IDs is not discarded", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-usage-id-collision-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const [index, timestamp] of ["2026-09-21T10:03:00.000Z", "2026-09-22T10:03:00.000Z"].entries()) {
		writeFileSync(
			join(root, `${index}.jsonl`),
			[
				session(`session-${index}`, "/repo/project"),
				JSON.stringify({
					type: "usage",
					id: "aabbccdd",
					timestamp,
					kind: "cache_warm",
					provider: "provider",
					model: "model",
					usage: { input: 20, cost: { total: 0.7 } },
				}),
			].join("\n"),
		);
	}
	const result = await scanSessions(root);
	assert.equal(result.records.length, 2);
	assert.equal(result.duplicateRecords, 0);
});

test("malformed JSONL records are counted rather than crashing the scanner", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-usage-invalid-record-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(
		join(root, "session.jsonl"),
		["null", "[]", "42", '"text"', "{", session("session", "/repo"), assistant("a", "response", 1)].join("\n"),
	);
	const result = await scanSessions(root);
	assert.equal(result.invalidLines, 5);
	assert.equal(result.records.length, 1);
});
