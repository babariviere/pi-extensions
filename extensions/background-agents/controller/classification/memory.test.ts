import assert from "node:assert/strict";
import { test } from "node:test";
import { BackgroundAgentsDatabase } from "../database.ts";
import { retrieveRelatedCases } from "./memory.ts";

function sourceEvent(sourceKey: string, title: string, fingerprint?: string) {
	return {
		source: "slack" as const,
		sourceKey,
		revision: "1",
		receivedAt: "2026-01-01T00:00:00Z",
		title,
		body: "unindexed source payload",
		fingerprint,
	};
}

test("retrieves exact source identifiers and fingerprints before bounded FTS", () => {
	const database = new BackgroundAgentsDatabase(":memory:");
	const exact = database.recordSourceEvent(sourceEvent("slack:exact", "Unrelated title", "fp-exact"));
	database.recordSourceEvent(sourceEvent("slack:fts", "Checkout timeout recurrence"));
	const related = retrieveRelatedCases(database, {
		sourceKeys: ["slack:exact"],
		fingerprints: ["fp-exact"],
		text: "checkout timeout",
		limit: 3,
	});
	assert.equal(related[0]?.caseId, exact.caseId);
	assert.equal(related[0]?.provenance, "source-key:slack:exact");
	assert.ok(related.some((item) => item.provenance === "fts:case-summary"));
	database.close();
});

test("indexes only approved summaries and reports memory provenance and supersession", () => {
	const database = new BackgroundAgentsDatabase(":memory:");
	const prior = database.recordSourceEvent(sourceEvent("slack:prior", "Prior case"));
	const oldMemory = database.createMemoryEntry({
		caseId: prior.caseId,
		finding: "cache invalidation was incomplete",
		evidenceSummary: "verified in a bounded test",
		confidence: 80,
		scope: "repository:shop",
	});
	const pending = retrieveRelatedCases(database, { text: "cache invalidation" });
	assert.equal(pending.length, 0);
	database.approveMemoryEntry(oldMemory, "operator");
	const replacement = database.createMemoryEntry({
		caseId: prior.caseId,
		finding: "cache invalidation is fixed",
		evidenceSummary: "verified by the replacement check",
		confidence: 90,
		scope: "repository:shop",
		supersedesId: oldMemory,
	});
	database.approveMemoryEntry(replacement, "operator");
	const related = retrieveRelatedCases(database, { text: "cache invalidation" });
	const memoryMatch = related.find((item) => item.memoryIds?.includes(oldMemory));
	assert.ok(memoryMatch);
	assert.equal(memoryMatch?.provenance, `fts:approved-memory:${oldMemory}`);
	assert.deepEqual(memoryMatch?.supersededBy, [replacement]);
	assert.equal(database.get<{ count: number }>("SELECT count(*) AS count FROM approved_memory_fts")?.count, 2);
	database.close();
});
