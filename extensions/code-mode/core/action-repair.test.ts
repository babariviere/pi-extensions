import assert from "node:assert/strict";
import { test } from "node:test";

import { formatUnknownActionMessage, repairActionName } from "./action-repair.ts";

const AGENT_ACTIONS = ["list", "run", "runAll", "start", "wait", "status", "cancel"];

test("a semantic verb repairs to the single declared class member", () => {
	assert.equal(repairActionName(AGENT_ACTIONS, "execute").repaired, "run");
	assert.equal(repairActionName(AGENT_ACTIONS, "abort").repaired, "cancel");
	assert.equal(repairActionName(AGENT_ACTIONS, "launch").repaired, "start");
});

test("casing and separator variants repair structurally", () => {
	assert.equal(repairActionName(AGENT_ACTIONS, "run_all").repaired, "runAll");
	// A prefix-aligned spelling stays ambiguous between run and runAll, so the
	// failure tier enumerates both instead of guessing.
	assert.deepEqual(repairActionName(AGENT_ACTIONS, "RUNALL"), { suggestions: ["run", "runAll"] });
});

test("a bounded typo repairs to the unique nearest name", () => {
	assert.equal(repairActionName(AGENT_ACTIONS, "statuss").repaired, "status");
});

test("an unmatched name suggests instead of repairing", () => {
	const repair = repairActionName(AGENT_ACTIONS, "teleport");
	assert.equal(repair.repaired, undefined);
});

test("the failure message keeps its prefix and names candidates", () => {
	assert.equal(formatUnknownActionMessage("agents.nope", []), "Unknown Spindle action: agents.nope");
	assert.equal(
		formatUnknownActionMessage("agents.nope", ["agents.run", "agents.wait"]),
		"Unknown Spindle action: agents.nope (did you mean: agents.run, agents.wait?)",
	);
});
