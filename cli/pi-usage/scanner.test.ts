import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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
