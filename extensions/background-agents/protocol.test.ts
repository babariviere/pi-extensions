import assert from "node:assert/strict";
import { test } from "node:test";
import { validateBackgroundRequest } from "./protocol.ts";

test("evidence reproduction accepts only a durable manifest id", () => {
	assert.equal(
		validateBackgroundRequest({
			version: 1,
			id: "replay",
			type: "evidence.reproduce",
			caseId: "case-1",
			manifestId: "manifest-1",
		}),
		undefined,
	);
	assert.match(
		String(
			validateBackgroundRequest({
				version: 1,
				id: "upload",
				type: "evidence.reproduce",
				caseId: "case-1",
				manifest: { version: 1 },
			}),
		),
		/manifestId/,
	);
});
