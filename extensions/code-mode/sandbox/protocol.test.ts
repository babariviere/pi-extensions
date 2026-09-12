import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSandboxRequestEvent } from "./protocol.ts";

test("a well-formed request is accepted, with its roots", () => {
	const parsed = parseSandboxRequestEvent({
		policy: { mode: "workspace-write", allowWrite: ["/a", " ", "/b"], denyRead: ["/todos", " "] },
		reason: "night run started",
	});
	assert.deepEqual(parsed, {
		policy: { mode: "workspace-write", allowWrite: ["/a", "/b"], denyRead: ["/todos"] },
		reason: "night run started",
	});
});

test("a null policy is a revert, not a rejection", () => {
	assert.deepEqual(parseSandboxRequestEvent({ policy: null, reason: "ended" }), {
		policy: null,
		reason: "ended",
	});
	assert.deepEqual(parseSandboxRequestEvent({}), { policy: null });
});

test("junk on the bus is ignored rather than trusted", () => {
	assert.equal(parseSandboxRequestEvent(undefined), undefined);
	assert.equal(parseSandboxRequestEvent("workspace-write"), undefined);
	assert.equal(parseSandboxRequestEvent({ policy: { mode: "yolo" } }), undefined);
	assert.equal(parseSandboxRequestEvent({ policy: ["workspace-write"] }), undefined);
});

test("a mode with no roots is still a valid request", () => {
	assert.deepEqual(parseSandboxRequestEvent({ policy: { mode: "read-only" } }), {
		policy: { mode: "read-only" },
	});
});
