import assert from "node:assert/strict";
import test from "node:test";
import { completedAssistantTurns, sessionAdvisory, sessionAdvisoryCheckpoint } from "./session-advisory.ts";

test("session advisory checkpoints only once every 100 completed assistant turns", () => {
	assert.equal(sessionAdvisoryCheckpoint(99, 0), undefined);
	assert.equal(sessionAdvisoryCheckpoint(100, 0), 100);
	assert.equal(sessionAdvisoryCheckpoint(101, 100), undefined);
	assert.equal(sessionAdvisoryCheckpoint(200, 100), 200);
	assert.equal(sessionAdvisoryCheckpoint(201, 200), undefined);
	assert.equal(sessionAdvisoryCheckpoint(250, 200), undefined);
});

test("resuming or revisiting an already advised checkpoint does not warn again", () => {
	assert.equal(sessionAdvisoryCheckpoint(100, 100), undefined);
	assert.equal(sessionAdvisoryCheckpoint(150, 200), undefined);
});

test("count only completed assistant messages on the active branch", () => {
	assert.equal(
		completedAssistantTurns([
			{ type: "message", message: { role: "user" } },
			{ type: "message", message: { role: "assistant" } },
			{ type: "compaction" },
			{ type: "message", message: { role: "toolResult" } },
			{ type: "message", message: { role: "assistant" } },
		]),
		2,
	);
});

test("session advisory shows measured context and active children without claiming quota usage", () => {
	const text = sessionAdvisory({ turns: 200, contextTokens: 123_456, activeAgents: 2 });
	assert.match(text, /200 assistant turns/);
	assert.match(text, /123k tokens/);
	assert.match(text, /2 active subagents/);
	assert.match(text, /fresh session/);
	assert.match(text, /worklog/);
	assert.match(text, /todos/);
	assert.match(text, /Do not interrupt an active task or reset automatically/);
	assert.doesNotMatch(text, /weekly|quota|cost/);
});

test("session advisory handles missing context and no agents", () => {
	const text = sessionAdvisory({ turns: 100, activeAgents: 0 });
	assert.match(text, /100 assistant turns/);
	assert.doesNotMatch(text, /latest context|active subagents/);
});
