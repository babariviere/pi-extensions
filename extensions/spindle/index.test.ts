import assert from "node:assert/strict";
import test from "node:test";
import { FULL_CODE_GUIDANCE } from "./index.ts";

test("full-code guidance requires dedicated tools for manual edits", () => {
	assert.match(
		FULL_CODE_GUIDANCE,
		/Manual file edits must use `pi\.edit\(\{ path, edits: \[\{ oldText, newText \}\] \}\)` or `pi\.write`\./,
	);
	assert.match(FULL_CODE_GUIDANCE, /If `pi\.edit` fails, reread the target file and retry with updated exact text\./);
	assert.match(
		FULL_CODE_GUIDANCE,
		/Do not use `python`, `sed`, `perl`, `awk`, `cat`, `tee`, or shell redirection for manual edits\./,
	);
	assert.match(FULL_CODE_GUIDANCE, /Formatters, generators, migrations, builds, and tests are allowed\./);
});
