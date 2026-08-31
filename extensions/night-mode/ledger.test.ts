import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_NIGHT_CONFIG, type NightConfig } from "./config.ts";
import {
	carryOver,
	classify,
	counts,
	fingerprint,
	formatLedger,
	formatUnresolved,
	type LedgerItem,
	ledgerDir,
	parseLedgerItem,
	readField,
	readLedger,
	runIdFor,
	runTag,
	todosDir,
	unresolved,
	verifyLedger,
} from "./ledger.ts";
import { appendUnderHeading, composeCarryOver, composeNudge } from "./prompt.ts";

const todoFile = (front: Record<string, unknown>, body = ""): string => `${JSON.stringify(front, null, 2)}\n\n${body}`;

describe("readField", () => {
	it("finds a labelled line whatever the decoration", () => {
		assert.equal(readField("Evidence: https://x/1", "evidence"), "https://x/1");
		assert.equal(readField("- **Evidence**: https://x/2", "evidence"), "https://x/2");
		assert.equal(readField("notes\nReason:  too vague  \n", "reason"), "too vague");
	});

	it("ignores an empty value", () => {
		assert.equal(readField("Evidence:", "evidence"), undefined);
		assert.equal(readField("nothing here", "evidence"), undefined);
	});
});

describe("classify", () => {
	it("treats an open item as pending", () => {
		assert.equal(classify("open", "").state, "pending");
		assert.equal(classify("in-progress", "Evidence: x").state, "pending");
	});

	it("only accepts a close that carries evidence", () => {
		assert.equal(classify("done", "").state, "unverified");
		assert.equal(classify("closed", "Evidence: https://github.com/x/pull/1").state, "done");
	});

	it("only accepts a skip that carries a reason", () => {
		assert.equal(classify("skipped", "").state, "unverified");
		assert.equal(classify("skipped", "Reason: needs a product call").state, "skipped");
	});
});

describe("parseLedgerItem", () => {
	it("ignores todos that are not tagged night", () => {
		assert.equal(parseLedgerItem("a1", todoFile({ id: "a1", tags: ["qa"], status: "open" })), undefined);
	});

	it("reads a night todo and its evidence", () => {
		const item = parseLedgerItem(
			"a1",
			todoFile({ id: "a1", title: "flaky-login", tags: ["night"], status: "done" }, "Evidence: https://x/1"),
		);
		assert.equal(item?.state, "done");
		assert.equal(item?.evidence, "https://x/1");
		assert.equal(item?.title, "flaky-login");
	});

	it("survives a malformed file", () => {
		assert.equal(parseLedgerItem("a1", "{not json"), undefined);
	});
});

describe("ledger tallies", () => {
	const items: LedgerItem[] = [
		{ id: "1", title: "a", status: "open", state: "pending" },
		{ id: "2", title: "b", status: "done", state: "done", evidence: "url" },
		{ id: "3", title: "c", status: "done", state: "unverified" },
		{ id: "4", title: "d", status: "skipped", state: "skipped", reason: "why" },
	];

	it("counts an unverified close as still owing work", () => {
		assert.deepEqual(
			unresolved(items).map((item) => item.id),
			["1", "3"],
		);
		assert.deepEqual(counts(items), {
			total: 4,
			done: 1,
			skipped: 1,
			pending: 1,
			unverified: 1,
			needsReview: 0,
		});
	});

	it("explains why an unverified item is listed", () => {
		assert.match(formatUnresolved(items), /no Evidence:\/Reason: line/);
	});

	it("fingerprints state, so a nudge that changes nothing is detectable", () => {
		const same = items.map((item) => ({ ...item }));
		assert.equal(fingerprint(items), fingerprint(same));
		same[0].state = "done";
		assert.notEqual(fingerprint(items), fingerprint(same));
	});
});

describe("verifyLedger", () => {
	const item = (evidence: string): LedgerItem[] => {
		const parsed = parseLedgerItem("a1", todoFile({ id: "a1", title: "t", tags: ["night"], status: "done" }, evidence));
		return parsed ? [parsed] : [];
	};

	it("keeps a claim that checks out", () => {
		const [checked] = verifyLedger(item("Evidence: pr https://github.com/o/r/pull/3"));
		assert.equal(checked.state, "done");
		assert.equal(checked.verification?.ok, true);
	});

	// The 2026-08-31 failure: a deliverable deleted with its workspace, reported
	// as done because an `Evidence:` line existed.
	it("flips a claim that does not to needs-review, and keeps counting it as open", () => {
		const items = verifyLedger(item("Evidence: file /nope/gone.md"));
		assert.equal(items[0].state, "needs-review");
		assert.match(items[0].verification?.detail ?? "", /does not exist/);
		assert.deepEqual(
			unresolved(items).map((entry) => entry.id),
			["a1"],
		);
		assert.equal(counts(items).needsReview, 1);
		assert.match(formatUnresolved(items), /evidence failed/);
	});

	it("leaves an item that is not claiming to be done alone", () => {
		const open = parseLedgerItem("b2", todoFile({ id: "b2", title: "t", tags: ["night"], status: "open" }));
		assert.ok(open);
		assert.equal(verifyLedger([open])[0].verification, undefined);
	});

	it("checks a commit in the repo the evidence names", () => {
		const calls: string[] = [];
		const opts = {
			resolveCommit: (revision: string, repo: string) => {
				calls.push(`${revision}@${repo}`);
				return revision === "abc1234";
			},
		};
		assert.equal(verifyLedger(item("Evidence: commit abc1234 (repo: /src/x)"), opts)[0].state, "done");
		assert.equal(verifyLedger(item("Evidence: commit dead999 (repo: /src/x)"), opts)[0].state, "needs-review");
		assert.deepEqual(calls, ["abc1234@/src/x", "dead999@/src/x"]);
	});
});

describe("run scope", () => {
	it("derives a sortable run id from the run start", () => {
		assert.equal(runIdFor(new Date(2026, 7, 31, 19, 7)), "2026-08-31-1907");
		assert.equal(runTag("2026-08-31-1907"), "run:2026-08-31-1907");
	});

	it("reads the run tag back off a todo", () => {
		const parsed = parseLedgerItem(
			"a1",
			todoFile({ id: "a1", title: "t", tags: ["night", "run:2026-08-31-1907"], status: "open" }),
		);
		assert.equal(parsed?.runId, "2026-08-31-1907");
	});
});

describe("carryOver", () => {
	const open = (id: string, title: string, runId?: string): LedgerItem => ({
		id,
		title,
		status: "open",
		state: "pending",
		...(runId ? { runId } : {}),
	});

	it("carries only the run that is ending", () => {
		const result = carryOver(
			[
				open("1", "Old CI triage", "2026-08-28-1659"),
				open("2", "Auto-improvement pass", "2026-08-31-1907"),
				{ id: "3", title: "Shipped", status: "done", state: "done", runId: "2026-08-31-1907", evidence: "x" },
			],
			{ currentRunId: "2026-08-31-1907" },
		);
		assert.deepEqual(
			result.items.map((entry) => entry.id),
			["2"],
		);
		assert.equal(result.fromRunId, "2026-08-31-1907");
		assert.deepEqual(
			result.stale.map((entry) => entry.id),
			["1"],
		);
	});

	// Three of nine carried-over items on 2026-08-31 were duplicates of each other.
	it("dedupes by normalised title", () => {
		const result = carryOver(
			[
				open("1", "Obsidian daily note pass", "r1"),
				open("2", "obsidian  daily-note pass.", "r1"),
				open("3", "Insights pass", "r1"),
			],
			{ currentRunId: "r1" },
		);
		assert.deepEqual(
			result.items.map((entry) => entry.id),
			["1", "3"],
		);
		assert.deepEqual(
			result.duplicates.map((entry) => entry.id),
			["2"],
		);
	});

	it("falls back to the newest run when the current one has nothing open", () => {
		const result = carryOver([open("1", "a", "r1"), open("2", "b", "r2")], { currentRunId: "r3" });
		assert.equal(result.fromRunId, "r2");
		assert.deepEqual(
			result.items.map((entry) => entry.id),
			["2"],
		);
	});

	it("still works on a store written before run tags existed", () => {
		const result = carryOver([open("1", "a"), open("2", "a"), open("3", "b")]);
		assert.equal(result.fromRunId, undefined);
		assert.deepEqual(
			result.items.map((entry) => entry.id),
			["1", "3"],
		);
	});
});

describe("appendUnderHeading", () => {
	const report = "# R\n\n## Summary\n\n## Needs you\n\n## Timeline\n\n- 21:30 started\n";

	it("inserts under the right heading, not at the end", () => {
		const next = appendUnderHeading(report, "Needs you", "- decide on the flaky test");
		const lines = next.split("\n");
		assert.ok(lines.indexOf("- decide on the flaky test") > lines.indexOf("## Needs you"));
		assert.ok(lines.indexOf("- decide on the flaky test") < lines.indexOf("## Timeline"));
	});

	it("creates the heading when the agent removed it", () => {
		const next = appendUnderHeading("# R\n\n## Summary\n", "Needs you", "- x");
		assert.match(next, /## Needs you\n\n- x/);
	});
});

describe("continuation and carry-over prompts", () => {
	it("states the run is not over and how to close an item", () => {
		const text = composeNudge({
			unresolved: "- 1 a",
			reportPath: "/tmp/r.md",
			attempt: 2,
			maxAttempts: 10,
		});
		assert.match(text, /not over/);
		assert.match(text, /Evidence:/);
		assert.match(text, /continuation 2\/10/);
		assert.match(text, /not by the user/);
	});

	it("hands leftovers to the next night", () => {
		const text = composeCarryOver(new Date(2026, 7, 29, 21, 30), "- 1 a", "/tmp/r.md");
		assert.match(text, /Carried over from the night of 2026-08-29 2130/);
		assert.match(text, /- 1 a/);
	});
});

describe("ledgerDir", () => {
	const withTodoPath = (todoPath: string): NightConfig => ({ ...DEFAULT_NIGHT_CONFIG, todoPath });

	it("resolves the configured store", () => {
		assert.equal(ledgerDir(withTodoPath("/srv/night/todos"), "/repo"), "/srv/night/todos");
		assert.equal(ledgerDir(withTodoPath("night-todos"), "/repo"), "/repo/night-todos");
	});

	it("falls back to the cwd-derived store when the path is empty", () => {
		assert.equal(ledgerDir(withTodoPath(""), "/repo"), todosDir("/repo"));
	});

	// The regression this store exists for: a run rewrites cwd for its clone and
	// again for every subagent workspace, so a cwd-derived ledger forks and the
	// evidence a child writes is invisible to the coordinator.
	it("is the same directory from the coordinator, the clone and a subagent workspace", () => {
		const config = withTodoPath("/srv/night/todos");
		const coordinator = ledgerDir(config, "/repo");
		const clone = ledgerDir(config, "/srv/night/sandboxes/repo/2026-08-29 2130");
		const workspace = ledgerDir(config, "/srv/night/sandboxes/repo/2026-08-29 2130.agents/agent-ab12-0");
		assert.equal(clone, coordinator);
		assert.equal(workspace, coordinator);
		// And the cwd-derived store is what would have broken.
		assert.notEqual(todosDir("/srv/night/sandboxes/repo/2026-08-29 2130.agents/agent-ab12-0"), todosDir("/repo"));
	});

	it("reads back an item a subagent wrote from its own workspace", () => {
		const store = mkdtempSync(join(tmpdir(), "night-ledger-"));
		const config = withTodoPath(store);
		writeFileSync(
			join(ledgerDir(config, "/workspace/agent-ab12-0"), "a1.md"),
			todoFile({ id: "a1", title: "flaky-login", tags: ["night"], status: "done" }, "Evidence: https://x/1"),
		);
		const items = readLedger(ledgerDir(config, "/repo"));
		assert.equal(items.length, 1);
		assert.equal(items[0]?.state, "done");
		assert.equal(unresolved(items).length, 0);
	});
});

describe("formatLedger", () => {
	const item = (over: Partial<LedgerItem>): LedgerItem => ({
		id: "a1",
		title: "t",
		status: "open",
		state: "pending",
		...over,
	});

	it("marks each state, and shows why a resolved item counts", () => {
		const lines = formatLedger([
			item({ id: "a1", title: "triage CI", status: "in-progress" }),
			item({ id: "a2", title: "flaky login", status: "done", state: "done", evidence: "https://x/1" }),
			item({ id: "a3", title: "upgrade node", status: "skipped", state: "skipped", reason: "needs a call" }),
			item({ id: "a4", title: "lint", status: "done", state: "unverified" }),
		]).split("\n");
		assert.equal(lines[0], "- [ ] a1 triage CI - in-progress");
		assert.equal(lines[1], "- [?] a4 lint - marked 'done', no Evidence:/Reason:");
		assert.equal(lines[2], "- [x] a2 flaky login - evidence: https://x/1");
		assert.equal(lines[3], "- [-] a3 upgrade node - reason: needs a call");
	});

	it("omits a pending item's status when it is the default", () => {
		assert.equal(formatLedger([item({ title: "triage CI" })]), "- [ ] a1 triage CI");
	});

	it("is empty for an empty ledger", () => {
		assert.equal(formatLedger([]), "");
	});
});
