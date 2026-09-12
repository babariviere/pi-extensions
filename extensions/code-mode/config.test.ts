import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeSpindleConfig } from "./config.ts";

test("stale sandbox network keys stay inert through normalizeSpindleConfig", () => {
	// A spindle.json written before the Seatbelt migration may still carry
	// these keys. There is no schema validation on this path
	// (readJsonObjectFile / normalizeSpindleConfig), so an unknown key must
	// simply be ignored rather than throwing or resurrecting network config.
	const config = normalizeSpindleConfig({
		sandbox: { mode: "read-only", allowedDomains: ["x"], allowLoopback: true },
	});
	assert.equal(config.sandbox.mode, "read-only");
	assert.equal((config.sandbox as unknown as Record<string, unknown>).allowedDomains, undefined);
	assert.equal((config.sandbox as unknown as Record<string, unknown>).allowLoopback, undefined);
});
