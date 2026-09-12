import assert from "node:assert/strict";
import { test } from "node:test";
import { ActionRegistry } from "./action-registry.ts";
import type { SpindleProvider } from "../protocol.ts";

const provider = (name: string): SpindleProvider => ({
	name,
	description: name,
	list: async () => [],
	describe: async () => undefined,
	invoke: async () => null,
});

test("registration cannot restore the removed namespace or overwrite guest helpers", () => {
	const registry = new ActionRegistry();
	for (const name of ["extensions", "tools", "process", "console", "print"]) {
		assert.throws(() => registry.register(provider(name)), /Invalid Spindle provider name/);
		assert.equal(registry.has(name), false);
	}
	registry.register(provider("reports"));
	assert.equal(registry.has("reports"), true);
});
