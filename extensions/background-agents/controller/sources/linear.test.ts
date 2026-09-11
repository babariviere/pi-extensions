import assert from "node:assert/strict";
import { test } from "node:test";
import { LinearSourceAdapter } from "./linear.ts";
import type { SourceStore } from "./source.ts";

test("Linear polls only the authenticated user's active-cycle issues and stores revisions", async () => {
	const events: any[] = [];
	let cursor: unknown;
	let query = "";
	const adapter = new LinearSourceAdapter({
		store: {
			recordSourceEvent(event) {
				events.push(event);
				return { eventId: event.sourceKey, caseId: event.sourceKey, inserted: true };
			},
			setSourceCursor(_source, value, revision) {
				cursor = { value, revision };
			},
		} satisfies SourceStore,
		client: {
			async query<T>(value: string) {
				query = value;
				return {
					issues: {
						nodes: [
							{
								id: "1",
								identifier: "ENG-1",
								title: "Fix",
								description: "Details",
								updatedAt: "2026-01-01T00:00:00.000Z",
							},
						],
						pageInfo: { hasNextPage: false, endCursor: "end" },
					},
				} as T;
			},
		},
	});
	await adapter.poll();
	assert.match(query, /assignee:\s*\{\s*isMe:\s*\{\s*eq:\s*true/);
	assert.equal(events[0].revision, "2026-01-01T00:00:00.000Z");
	assert.equal(events[0].sourceKey, "linear:1");
	assert.match(String((cursor as any).value), /endCursor/);
});
