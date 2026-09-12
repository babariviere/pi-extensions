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

test("work-item approval requires a case, exact item, and specification version", () => {
	assert.equal(
		validateBackgroundRequest({
			version: 1,
			id: "approve-item",
			type: "work-item.approve",
			caseId: "case-1",
			workItemId: "item-1",
			specVersion: 2,
		}),
		undefined,
	);
	assert.match(
		String(
			validateBackgroundRequest({
				version: 1,
				id: "approve-item",
				type: "work-item.approve",
				caseId: "case-1",
				workItemId: "item-1",
				specVersion: 0,
			}),
		),
		/specVersion/,
	);
});
