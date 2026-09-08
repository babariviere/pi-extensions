import assert from "node:assert/strict";
import { test } from "node:test";

import { hostCallTable } from "./host-calls.ts";

test("display-only workflow host calls are not registered", () => {
	for (const ref of ["spindle.$spanStart", "spindle.$spanEnd", "spindle.$items"]) {
		assert.equal(hostCallTable.has(ref), false);
	}
});
