import assert from "node:assert/strict";
import { test } from "node:test";
import { DatadogSourceAdapter } from "./datadog.ts";
import type { SourceStore } from "./source.ts";

test("Datadog uses overlap, stable fingerprints, and a durable watermark", async () => {
	const events: any[] = [];
	let cursor: any;
	const adapter = new DatadogSourceAdapter({
		store: {
			recordSourceEvent(event) {
				events.push(event);
				return { eventId: event.fingerprint!, caseId: "c", inserted: true };
			},
			getSourceCursor() {
				return { cursor: JSON.stringify({ watermark: "2026-01-01T00:00:00.000Z" }) };
			},
			setSourceCursor(_source, value) {
				cursor = JSON.parse(value!);
			},
		} satisfies SourceStore,
		client: {
			async queryMonitors(_query, from, to) {
				assert.equal(from, "2025-12-31T23:55:00.000Z");
				assert.equal(to, "2026-01-01T00:01:00.000Z");
				return [{ id: "m1", timestamp: "2026-01-01T00:00:30.000Z", name: "Down", status: "Alert" }];
			},
			async queryErrors() {
				return [];
			},
		},
		monitorQueries: [{ id: "monitors", query: "status:Alert" }],
		now: () => new Date("2026-01-01T00:01:00.000Z"),
	});
	await adapter.poll();
	assert.equal(events.length, 1);
	assert.equal(cursor.watermark, "2026-01-01T00:01:00.000Z");
});

test("Datadog rejects a successful response without a results array and retains its watermark", async () => {
	let cursor = JSON.stringify({ watermark: "2026-01-01T00:00:00.000Z" });
	const adapter = new DatadogSourceAdapter({
		store: {
			recordSourceEvent() {
				return { eventId: "event", caseId: "case", inserted: true };
			},
			getSourceCursor() {
				return { cursor };
			},
			setSourceCursor(_source, value) {
				cursor = value!;
			},
		} satisfies SourceStore,
		client: {
			async queryMonitors() {
				return { status: "ok" } as never;
			},
			async queryErrors() {
				return [];
			},
		},
		monitorQueries: [{ id: "monitor", query: "status:Alert" }],
		now: () => new Date("2026-01-01T00:01:00.000Z"),
	});
	await assert.rejects(adapter.poll(), /results array/);
	assert.equal(cursor, JSON.stringify({ watermark: "2026-01-01T00:00:00.000Z" }));
});
