import assert from "node:assert/strict";
import { test } from "node:test";
import { ManualSourceAdapter } from "./manual.ts";
import type { SourceStore } from "./source.ts";

test("manual intake uses the shared source boundary", () => {
	const events: any[] = [];
	const adapter = new ManualSourceAdapter({
		store: {
			recordSourceEvent(event) {
				events.push(event);
				return { eventId: "e", caseId: "c", inserted: true };
			},
		} satisfies SourceStore,
		now: () => new Date("2026-01-01T00:00:00Z"),
	});
	const result = adapter.submit({ title: " Bug ", body: "Details", kind: "bug-report", sourceKey: "42" });
	assert.equal(result.caseId, "c");
	assert.equal(events[0].sourceKey, "manual:42");
	assert.equal(events[0].metadata.kind, "bug-report");
	assert.equal(events[0].receivedAt, "2026-01-01T00:00:00.000Z");
});
