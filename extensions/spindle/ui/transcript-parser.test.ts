import assert from "node:assert/strict";
import { test } from "node:test";

import { TranscriptAccumulator } from "./transcript-parser.ts";

/**
 * pi 0.84.0 made `message_update` delta-only: no cumulative `message`, no
 * `assistantMessageEvent.partial`. Live assistant text must therefore be
 * assembled from `text_delta` deltas.
 */
test("assembles live assistant text from delta-only message_update events", () => {
	const acc = new TranscriptAccumulator();
	acc.append([
		{ type: "message_start", message: { role: "assistant", content: [] } },
		{ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
		{ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" } },
		{ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo" } },
	]);

	const assistant = acc.entries.filter((entry) => entry.kind === "assistant");
	assert.equal(assistant.length, 1);
	assert.equal(assistant[0].text, "Hello");
	assert.equal(assistant[0].status, "running");
});

test("text_end supplies the authoritative block and message_end completes the entry", () => {
	const acc = new TranscriptAccumulator();
	acc.append([
		{ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "par" } },
		{ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "partial then final" } },
		{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "partial then final" }] } },
	]);

	const assistant = acc.entries.filter((entry) => entry.kind === "assistant");
	assert.equal(assistant.length, 1);
	assert.equal(assistant[0].text, "partial then final");
	assert.equal(assistant[0].status, "completed");
});

test("concatenates multiple content blocks in index order and ignores non-text deltas", () => {
	const acc = new TranscriptAccumulator();
	acc.append([
		{ type: "message_update", usage: {}, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "hmm" } },
		{ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 2, delta: "second" } },
		{ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "first " } },
	]);

	const assistant = acc.entries.filter((entry) => entry.kind === "assistant");
	assert.equal(assistant.length, 1);
	assert.equal(assistant[0].text, "first second");
});

test("a new turn does not inherit the previous turn's stream buffer", () => {
	const acc = new TranscriptAccumulator();
	acc.append([
		{ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "one" } },
		{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "one" }] } },
		{ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "two" } },
	]);

	const assistant = acc.entries.filter((entry) => entry.kind === "assistant");
	assert.equal(assistant.length, 2);
	assert.equal(assistant[0].text, "one");
	assert.equal(assistant[1].text, "two");
});
