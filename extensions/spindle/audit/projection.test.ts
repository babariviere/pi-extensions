import assert from "node:assert/strict";
import { test } from "node:test";

import { projectSpindleAuditArgs } from "./projection.ts";

test("applyPatch audit projection drops patch contents", () => {
	assert.deepEqual(projectSpindleAuditArgs("pi.applyPatch", { patch: "secret source text" }), {
		value: {},
		droppedValues: 1,
	});
});
