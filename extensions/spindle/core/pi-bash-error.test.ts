import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyPiBashError, piBashExitMetadata, piBashResultError } from "./pi-bash-error.ts";

test("an ordinary nonzero exit is classified with its status", () => {
	const classified = classifyPiBashError(new Error("stdout line\n\nCommand exited with code 3"));
	assert.deepEqual(piBashExitMetadata(classified), { exitCode: 3, output: "stdout line" });
});

test("an unrelated failure carries no exit metadata", () => {
	assert.equal(piBashExitMetadata(classifyPiBashError(new Error("permission denied"))), undefined);
	assert.equal(piBashExitMetadata(new Error("Command exited with code 3")), undefined);
});

test("the exit status survives a middleware-rewritten result", () => {
	const classified = classifyPiBashError(new Error("stdout line\n\nCommand exited with code 5"));
	const rewritten = piBashResultError(classified, "[redacted]\n\nCommand exited with code 5");
	assert.deepEqual(piBashExitMetadata(rewritten), { exitCode: 5, output: "[redacted]" });
});

test("an unclassified error becomes a plain failure", () => {
	const error = piBashResultError(new Error("anything"), "blocked by policy");
	assert.equal(piBashExitMetadata(error), undefined);
	assert.equal(error.message, "blocked by policy");
});
