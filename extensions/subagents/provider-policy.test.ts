import assert from "node:assert/strict";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { builtinAgent } from "./discovery.ts";
import { buildRunRequests } from "./request.ts";

for (const model of ["other/model", "other/model:high"]) {
	test(`rejects cross-provider agent configuration: ${model}`, () => {
		const agent = builtinAgent();
		agent.config.model = model;
		const result = buildRunRequests({ task: "work" }, [agent], tmpdir(), undefined, "parent");
		assert.ok("error" in result);
		assert.match(result.error, /must use the caller's provider/);
	});
}

for (const model of ["model", "model:high", "parent/model"]) {
	test(`pins agent configuration to caller provider: ${model}`, () => {
		const agent = builtinAgent();
		agent.config.model = model;
		const result = buildRunRequests({ task: "work" }, [agent], tmpdir(), undefined, "parent");
		assert.ok("requests" in result);
		assert.equal(result.requests[0].overrides?.model, model.includes("/") ? model : `parent/${model}`);
	});
}
