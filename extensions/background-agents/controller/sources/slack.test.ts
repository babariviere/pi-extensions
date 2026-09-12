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
			payload: { team_id: "T-workspace-1", event: { event_id: "evt-1", type: "message", text: "hello" } },
		}),
		fakeSocket(sent),
	);
	order.push("after");
	assert.deepEqual(order, ["persist", "after"]);
	assert.deepEqual(JSON.parse(sent[0]), { envelope_id: "env-1" });
});

test("Slack scopes event keys by workspace and rejects missing identity", async () => {
	const sourceKeys: string[] = [];
	const adapter = new SlackSourceAdapter({
		store: {
			recordSourceEvent(event) {
				sourceKeys.push(event.sourceKey);
				return { eventId: event.sourceKey, caseId: "case", inserted: true };
			},
		} satisfies SourceStore,
	});
	const event = (team_id: string) =>
		JSON.stringify({
			envelope_id: `env-${team_id}`,
			type: "events_api",
			payload: { team_id, event: { event_id: "same-event", type: "message", text: "hello" } },
		});
	await adapter.handleEnvelope(event("T-one"));
	await adapter.handleEnvelope(event("T-two"));
	assert.deepEqual(sourceKeys, ["slack:T-one:same-event", "slack:T-two:same-event"]);
	await assert.rejects(
		adapter.handleEnvelope(
			JSON.stringify({ envelope_id: "env-missing", type: "events_api", payload: { event: { event_id: "evt" } } }),
		),
		/missing workspace\/team identity/,
	);
	await assert.rejects(
		adapter.handleEnvelope(
			JSON.stringify({
				envelope_id: "env-invalid",
				type: "events_api",
				payload: { team_id: 42, event: { event_id: "evt" } },
			}),
		),
		/invalid workspace\/team identity/,
	);
});
