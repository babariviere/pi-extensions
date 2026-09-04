import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { parseLedgerItem } from "./ledger.ts";
import { formatApprovedPlan, seedApprovedLedger } from "./plan.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("approved night plan", () => {
	it("creates todo-extension records scoped to the approved run", async () => {
		const dir = mkdtempSync(join(tmpdir(), "night-plan-"));
		roots.push(dir);
		const [task] = await seedApprovedLedger(
			dir,
			"2026-09-05-2100",
			[
				{
					title: "Correct phishing documentation",
					goal: "Compare repository documentation with current behavior and correct inaccuracies.",
					repository: "/repo/phishing",
					definitionOfDone: "Documentation checks pass and a draft PR exists.",
					briefs: ["/notes/Repo Flow.md"],
					needs: ["gh-auth"],
					findings: "The setup page still names the retired command.",
				},
			],
			new Date("2026-09-05T21:00:00.000Z"),
		);
		const body = readFileSync(join(dir, `${task.id}.md`), "utf8");
		const ledger = parseLedgerItem(task.id, body);
		assert.equal(ledger?.title, "Correct phishing documentation");
		assert.equal(ledger?.runId, "2026-09-05-2100");
		assert.deepEqual(ledger?.needs, ["gh-auth"]);
		assert.match(body, /Documentation checks pass/);
		assert.match(body, /Planning findings/);
	});

	it("formats the exact ids handed to the orchestrator", () => {
		const text = formatApprovedPlan([
			{
				id: "abcd1234",
				title: "One task",
				goal: "Do one thing",
				repository: "/repo",
				definitionOfDone: "One focused test passes",
			},
		]);
		assert.match(text, /TODO-abcd1234/);
		assert.match(text, /One focused test passes/);
	});
});
