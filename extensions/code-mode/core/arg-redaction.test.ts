import assert from "node:assert/strict";
import { test } from "node:test";

import { redactRecordedArgs } from "./arg-redaction.ts";

test("redacts pi.bash env values and stdin", () => {
	const out = redactRecordedArgs("pi.bash", {
		command: "ls",
		env: { FOO: "secret-value", BAR: "x" },
		stdin: "hello\nworld",
	});
	assert.deepEqual(out.env, {
		FOO: "<redacted: 12 chars>",
		BAR: "<redacted: 1 chars>",
	});
	assert.equal(out.stdin, "<stdin: 11 chars>");
	assert.equal(out.command, "ls");
});

test("leaves bare bash args and other refs untouched", () => {
	const bashArgs = { command: "ls" };
	assert.equal(redactRecordedArgs("pi.bash", bashArgs), bashArgs);
	const otherArgs = { command: "ls", env: { A: "b" }, stdin: "c" };
	assert.equal(redactRecordedArgs("mcp.server.tool", otherArgs), otherArgs);
});
