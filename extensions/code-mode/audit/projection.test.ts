import assert from "node:assert/strict";
import { test } from "node:test";

import { projectCodeModeAuditArgs, projectCodeModeAuditResult } from "./projection.ts";

test("applyPatch audit projection keeps paths but drops patch contents", () => {
	assert.deepEqual(
		projectCodeModeAuditArgs("pi.applyPatch", {
			patch: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-secret source text\n+replacement\n*** End Patch",
		}),
		{ value: { paths: ["src/a.ts"] }, droppedValues: 0 },
	);
});

test("applyPatch result projection keeps only bounded local path and kind metadata", () => {
	const projection = projectCodeModeAuditResult("pi.applyPatch", {
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
