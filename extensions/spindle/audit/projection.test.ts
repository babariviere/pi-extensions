import assert from "node:assert/strict";
import { test } from "node:test";

import { projectSpindleAuditArgs, projectSpindleAuditResult } from "./projection.ts";

test("applyPatch audit projection drops patch contents", () => {
	assert.deepEqual(projectSpindleAuditArgs("pi.applyPatch", { patch: "secret source text" }), {
		value: {},
		droppedValues: 1,
	});
});

test("applyPatch result projection keeps only bounded local path and kind metadata", () => {
	const projection = projectSpindleAuditResult("pi.applyPatch", {
		content: [{ type: "text", text: "secret source text" }],
		details: {
			changes: [
				{ kind: "update", path: "src/a.ts", source: "secret source text" },
				{ kind: "move", path: "src/b.ts", moveTo: "src/c.ts", prompt: "secret prompt" },
				{ kind: "add", path: "https://user:password@example.com/file.ts" },
				{ kind: "delete", path: `src/${"x".repeat(600)}.ts` },
			],
		},
	});

	assert.deepEqual(projection?.value, {
		changes: [
			{ kind: "update", path: "src/a.ts" },
			{ kind: "move", path: "src/b.ts", moveTo: "src/c.ts" },
		],
	});
	const serialized = JSON.stringify(projection);
	assert.doesNotMatch(serialized, /secret|password|example\.com/);
	assert.ok(Buffer.byteLength(serialized, "utf8") < 2_048);
});
