import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	classify,
	counts,
	fingerprint,
	formatUnresolved,
	type LedgerItem,
	parseLedgerItem,
	readField,
	unresolved,
} from "./ledger.ts";
import {
	appendUnderHeading,
	composeCarryOver,
	composeNudge,
} from "./prompt.ts";

const todoFile = (front: Record<string, unknown>, body = ""): string =>
	`${JSON.stringify(front, null, 2)}\n\n${body}`;

describe("readField", () => {
	it("finds a labelled line whatever the decoration", () => {
		assert.equal(readField("Evidence: https://x/1", "evidence"), "https://x/1");
		assert.equal(
			readField("- **Evidence**: https://x/2", "evidence"),
			"https://x/2",
		);
		assert.equal(
			readField("notes\nReason:  too vague  \n", "reason"),
			"too vague",
		);
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
		assert.equal(
			classify("closed", "Evidence: https://github.com/x/pull/1").state,
			"done",
		);
	});

	it("only accepts a skip that carries a reason", () => {
		assert.equal(classify("skipped", "").state, "unverified");
		assert.equal(
			classify("skipped", "Reason: needs a product call").state,
			"skipped",
		);
	});
});

describe("parseLedgerItem", () => {
	it("ignores todos that are not tagged night", () => {
		assert.equal(
			parseLedgerItem(
				"a1",
				todoFile({ id: "a1", tags: ["qa"], status: "open" }),
			),
			undefined,
		);
	});

	it("reads a night todo and its evidence", () => {
		const item = parseLedgerItem(
			"a1",
			todoFile(
				{ id: "a1", title: "HS-1234", tags: ["night"], status: "done" },
				"Evidence: https://x/1",
			),
		);
		assert.equal(item?.state, "done");
		assert.equal(item?.evidence, "https://x/1");
		assert.equal(item?.title, "HS-1234");
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

describe("appendUnderHeading", () => {
	const report =
		"# R\n\n## Summary\n\n## Needs Bastien\n\n## Timeline\n\n- 21:30 started\n";

	it("inserts under the right heading, not at the end", () => {
		const next = appendUnderHeading(
			report,
			"Needs Bastien",
			"- decide on HS-1",
		);
		const lines = next.split("\n");
		assert.ok(
			lines.indexOf("- decide on HS-1") > lines.indexOf("## Needs Bastien"),
		);
		assert.ok(lines.indexOf("- decide on HS-1") < lines.indexOf("## Timeline"));
	});

	it("creates the heading when the agent removed it", () => {
		const next = appendUnderHeading(
			"# R\n\n## Summary\n",
			"Needs Bastien",
			"- x",
		);
		assert.match(next, /## Needs Bastien\n\n- x/);
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
		const text = composeCarryOver(
			new Date(2026, 7, 29, 21, 30),
			"- 1 a",
			"/tmp/r.md",
		);
		assert.match(text, /Carried over from the night of 2026-08-29 2130/);
		assert.match(text, /- 1 a/);
	});
});
