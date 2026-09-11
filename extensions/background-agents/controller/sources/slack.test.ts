import assert from "node:assert/strict";
import { test } from "node:test";
import WebSocket from "ws";
import { SlackSourceAdapter } from "./slack.ts";
import type { SourceStore } from "./source.ts";

function fakeSocket(sent: string[]): WebSocket {
	return {
		readyState: WebSocket.OPEN,
		send(value: string) {
			sent.push(value);
		},
		close() {},
		on() {
			return this;
		},
	} as unknown as WebSocket;
}

test("Slack persists before acknowledging, including duplicate envelopes", async () => {
	const order: string[] = [];
	const adapter = new SlackSourceAdapter({
		store: {
			recordSourceEvent(event) {
				order.push("persist");
				return { eventId: event.sourceKey, caseId: "case", inserted: false };
			},
		} satisfies SourceStore,
	});
	const sent: string[] = [];
	await adapter.handleEnvelope(
		JSON.stringify({
			envelope_id: "env-1",
			type: "events_api",
			payload: { event: { event_id: "evt-1", type: "message", text: "hello" } },
		}),
		fakeSocket(sent),
	);
	order.push("after");
	assert.deepEqual(order, ["persist", "after"]);
	assert.deepEqual(JSON.parse(sent[0]), { envelope_id: "env-1" });
});
