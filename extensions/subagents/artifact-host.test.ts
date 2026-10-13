import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { requestParentArtifact } from "./artifact-host.ts";

test("parent artifact event requests preserve bound identity, match replies and release listeners", async () => {
	const emitter = new EventEmitter();
	const events = {
		emit: (channel: string, data: unknown) => {
			emitter.emit(channel, data);
		},
		on: (channel: string, handler: (data: unknown) => void) => {
			emitter.on(channel, handler);
			return () => {
				emitter.off(channel, handler);
			};
		},
	};
	const args = { action: "get", id: "parent-artifact", revision: 2 };
	emitter.on("subagents:artifact-call", (request) => {
		assert.equal(request.parentSessionId, "parent");
		assert.equal(request.name, "reviewer");
		assert.deepEqual(request.args, args);
		emitter.emit("subagents:artifact-result", { callId: "foreign", result: "FORBIDDEN" });
		emitter.emit("subagents:artifact-result", { callId: request.callId, result: "SOURCE" });
	});
	assert.equal(await requestParentArtifact(events, "parent", "reviewer", args), "SOURCE");
	assert.equal(emitter.listenerCount("subagents:artifact-result"), 0);
	emitter.removeAllListeners("subagents:artifact-call");
	const controller = new AbortController();
	const pending = requestParentArtifact(events, "parent", "reviewer", args, controller.signal);
	controller.abort();
	await assert.rejects(pending, /closed/);
	assert.equal(emitter.listenerCount("subagents:artifact-result"), 0);
});
