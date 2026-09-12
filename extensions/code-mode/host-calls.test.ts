import assert from "node:assert/strict";
import { test } from "node:test";

import { hostCallTable } from "./host-calls.ts";

test("display-only workflow host calls are not registered", () => {
	for (const ref of ["code-mode.$spanStart", "code-mode.$spanEnd", "code-mode.$items"]) {
		assert.equal(hostCallTable.has(ref), false);
	}
});
