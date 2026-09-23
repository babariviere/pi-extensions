import assert from "node:assert/strict";
import { test } from "node:test";
import { assertBackgroundAction, assertBackgroundReadPath, backgroundRole } from "./background-policy.ts";

test("background role requires a controller-selected supported role", () => {
	assert.equal(backgroundRole({}), undefined);
	assert.equal(
		backgroundRole({ PI_BACKGROUND_AGENT_ATTEMPT: "1", PI_BACKGROUND_AGENT_ROLE: "spec-planner" }),
		"spec-planner",
	);
	assert.throws(() => backgroundRole({ PI_BACKGROUND_AGENT_ATTEMPT: "1" }), /supported/);
});

test("background read roles cannot escape through Code Mode providers", () => {
	for (const role of ["investigator", "spec-planner"] as const) {
		assert.doesNotThrow(() => assertBackgroundAction(role, "pi.read"));
		assert.doesNotThrow(() => assertBackgroundAction(role, "mcp.call"));
		for (const action of ["pi.exec", "pi.applyPatch", "agents.run", "web.fetch", "tools.invoke"])
			assert.throws(() => assertBackgroundAction(role, action), /cannot invoke/);
	}
	assert.doesNotThrow(() => assertBackgroundAction("worker", "pi.applyPatch"));
	assert.throws(() => assertBackgroundAction("worker", "agents.run"), /cannot invoke/);
});

test("recursive reads cannot traverse the isolated MCP credential directory", () => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = "/attempt/pi-profile";
	try {
		assert.throws(
			() => assertBackgroundReadPath("spec-planner", "pi.grep", { path: "/attempt" }, "/repo"),
			/credential directory/,
		);
		assert.throws(
			() => assertBackgroundReadPath("spec-planner", "pi.read", { path: "/attempt/pi-profile/mcp.json" }, "/repo"),
			/credential directory/,
		);
		assert.doesNotThrow(() =>
			assertBackgroundReadPath("spec-planner", "pi.read", { path: "/attempt/context-manifest.json" }, "/repo"),
		);
		assert.doesNotThrow(() => assertBackgroundReadPath("spec-planner", "pi.grep", {}, "/repo"));
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
});
