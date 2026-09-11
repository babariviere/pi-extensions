import assert from "node:assert/strict";
import { test } from "node:test";
import { fingerprint, normalizeSourceEvent, persistSourceEvent, type SourceStore } from "./source.ts";

function store(): SourceStore & { events: unknown[]; cursors: unknown[] } {
	const events: unknown[] = [];
	const cursors: unknown[] = [];
	const value: SourceStore & { events: unknown[]; cursors: unknown[] } = {
		events,
		cursors,
		recordSourceEvent(event) {
			events.push(event);
			return { eventId: String(events.length), caseId: "case", inserted: true };
		},
		recordSourceEventAndAdvanceCursor(event, cursor) {
			const result = value.recordSourceEvent(event);
			cursors.push(cursor);
			return result;
		},
	};
	return value;
}

test("normalization and fingerprints are deterministic", () => {
	const first = fingerprint({ z: 1, a: 2 });
	assert.equal(first, fingerprint({ a: 2, z: 1 }));
	assert.equal(
		normalizeSourceEvent({ source: "manual", sourceKey: " id ", title: " Title ", body: "body" }).sourceKey,
		"id",
	);
});

test("persistence advances a cursor only after recording the event", () => {
	const target = store();
	persistSourceEvent(
		{ store: target },
		{ source: "linear", sourceKey: "linear:1", title: "Issue", body: "body" },
		{ cursor: "cursor" },
	);
	assert.equal(target.events.length, 1);
	assert.deepEqual(target.cursors, [{ cursor: "cursor" }]);
});
