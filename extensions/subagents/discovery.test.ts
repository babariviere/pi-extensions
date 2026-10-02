import assert from "node:assert/strict";
import { test } from "node:test";
import { builtinAgent } from "./discovery.ts";

test("generic kernels inherit native tools, context and skills without persona discovery", () => {
	const agent = builtinAgent();
	assert.equal(agent.scope, "builtin");
	assert.equal(agent.systemPrompt, "");
	assert.equal(agent.config.model, undefined);
	assert.equal(agent.config.inheritSkills, undefined);
	assert.equal(agent.config.inheritProjectContext, undefined);
	assert.notEqual(builtinAgent(), agent);
});
