// Copyright 2025 OpenAI. Licensed under Apache-2.0 (see apply-patch.LICENSE).
// Modified: Codex's 25 filesystem scenarios expressed as TypeScript test cases.
// Upstream revision and attribution: apply-patch.NOTICE.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { applyPatch } from "./apply-patch.ts";

type Snapshot = Record<string, string | null>;
interface Scenario {
	name: string;
	input: Snapshot;
	patch: string;
	expected: Snapshot;
	fails?: boolean;
}

const scenarios: Scenario[] = [
	{
		name: "001_add_file",
		input: {},
		patch: "*** Add File: bar.md\n+This is a new file",
		expected: { "bar.md": "This is a new file\n" },
	},
	{
		name: "002_multiple_operations",
		input: { "delete.txt": "obsolete\n", "modify.txt": "line1\nline2\n" },
		patch: "*** Add File: nested/new.txt\n+created\n*** Delete File: delete.txt\n*** Update File: modify.txt\n@@\n-line2\n+changed",
		expected: { "modify.txt": "line1\nchanged\n", "nested/": null, "nested/new.txt": "created\n" },
	},
	{
		name: "003_multiple_chunks",
		input: { "multi.txt": "line1\nline2\nline3\nline4\n" },
		patch: "*** Update File: multi.txt\n@@\n-line2\n+changed2\n@@\n-line4\n+changed4",
		expected: { "multi.txt": "line1\nchanged2\nline3\nchanged4\n" },
	},
	{
		name: "004_move_to_new_directory",
		input: { "old/": null, "old/name.txt": "old content\n", "old/other.txt": "unrelated file\n" },
		patch: "*** Update File: old/name.txt\n*** Move to: renamed/dir/name.txt\n@@\n-old content\n+new content",
		expected: {
			"old/": null,
			"old/other.txt": "unrelated file\n",
			"renamed/": null,
			"renamed/dir/": null,
			"renamed/dir/name.txt": "new content\n",
		},
	},
	{
		name: "005_rejects_empty_patch",
		input: { "foo.txt": "stable\n" },
		patch: "",
		expected: { "foo.txt": "stable\n" },
		fails: true,
	},
	{
		name: "006_rejects_missing_context",
		input: { "modify.txt": "line1\nline2\n" },
		patch: "*** Update File: modify.txt\n@@\n-missing\n+changed",
		expected: { "modify.txt": "line1\nline2\n" },
		fails: true,
	},
	{
		name: "007_rejects_missing_file_delete",
		input: { "foo.txt": "stable\n" },
		patch: "*** Delete File: missing.txt",
		expected: { "foo.txt": "stable\n" },
		fails: true,
	},
	{
		name: "008_rejects_empty_update_hunk",
		input: { "foo.txt": "stable\n" },
		patch: "*** Update File: foo.txt",
		expected: { "foo.txt": "stable\n" },
		fails: true,
	},
	{
		name: "009_requires_existing_file_for_update",
		input: { "foo.txt": "stable\n" },
		patch: "*** Update File: missing.txt\n@@\n-old\n+new",
		expected: { "foo.txt": "stable\n" },
		fails: true,
	},
	{
		name: "010_move_overwrites_existing_destination",
		input: {
			"old/": null,
			"old/name.txt": "from\n",
			"old/other.txt": "unrelated file\n",
			"renamed/": null,
			"renamed/dir/": null,
			"renamed/dir/name.txt": "existing\n",
		},
		patch: "*** Update File: old/name.txt\n*** Move to: renamed/dir/name.txt\n@@\n-from\n+new",
		expected: {
			"old/": null,
			"old/other.txt": "unrelated file\n",
			"renamed/": null,
			"renamed/dir/": null,
			"renamed/dir/name.txt": "new\n",
		},
	},
	{
		name: "011_add_overwrites_existing_file",
		input: { "duplicate.txt": "old content\n" },
		patch: "*** Add File: duplicate.txt\n+new content",
		expected: { "duplicate.txt": "new content\n" },
	},
	{
		name: "012_delete_directory_fails",
		input: { "dir/": null, "dir/foo.txt": "stable\n" },
		patch: "*** Delete File: dir",
		expected: { "dir/": null, "dir/foo.txt": "stable\n" },
		fails: true,
	},
	{
		name: "013_rejects_invalid_hunk_header",
		input: { "foo.txt": "stable\n" },
		patch: "*** Frobnicate File: foo",
		expected: { "foo.txt": "stable\n" },
		fails: true,
	},
	{
		name: "014_update_file_appends_trailing_newline",
		input: { "no_newline.txt": "no newline at end\n" },
		patch: "*** Update File: no_newline.txt\n@@\n-no newline at end\n+first line\n+second line",
		expected: { "no_newline.txt": "first line\nsecond line\n" },
	},
	{
		name: "015_failure_after_partial_success_leaves_changes",
		input: {},
		patch: "*** Add File: created.txt\n+hello\n*** Update File: missing.txt\n@@\n-old\n+new",
		expected: { "created.txt": "hello\n" },
		fails: true,
	},
	{
		name: "016_pure_addition_update_chunk",
		input: { "input.txt": "line1\nline2\n" },
		patch: "*** Update File: input.txt\n@@\n+added line 1\n+added line 2",
		expected: { "input.txt": "line1\nline2\nadded line 1\nadded line 2\n" },
	},
	{
		name: "017_whitespace_padded_hunk_header",
		input: { "foo.txt": "old\n" },
		patch: "  *** Update File: foo.txt\n@@\n-old\n+new",
		expected: { "foo.txt": "new\n" },
	},
	{
		name: "018_whitespace_padded_patch_markers",
		input: { "file.txt": "one\n" },
		patch: " *** Begin Patch\n*** Update File: file.txt\n@@\n-one\n+two\n*** End Patch \n",
		expected: { "file.txt": "two\n" },
	},
	{
		name: "019_unicode_simple",
		input: { "foo.txt": "line1\nnaïve café\nline3\n" },
		patch: "*** Update File: foo.txt\n@@\n line1\n-naïve café\n+naïve café ✅",
		expected: { "foo.txt": "line1\nnaïve café ✅\nline3\n" },
	},
	{
		name: "020_delete_file_success",
		input: { "keep.txt": "keep\n", "obsolete.txt": "obsolete\n" },
		patch: "*** Delete File: obsolete.txt",
		expected: { "keep.txt": "keep\n" },
	},
	{
		name: "020_whitespace_padded_patch_marker_lines",
		input: { "file.txt": "one\n" },
		patch: "*** Begin Patch \n*** Update File: file.txt\n@@\n-one\n+two\n *** End Patch\n",
		expected: { "file.txt": "two\n" },
	},
	{
		name: "021_update_file_deletion_only",
		input: { "lines.txt": "line1\nline2\nline3\n" },
		patch: "*** Update File: lines.txt\n@@\n line1\n-line2\n line3",
		expected: { "lines.txt": "line1\nline3\n" },
	},
	{
		name: "022_update_file_end_of_file_marker",
		input: { "tail.txt": "first\nsecond\n" },
		patch: "*** Update File: tail.txt\n@@\n first\n-second\n+second updated\n*** End of File",
		expected: { "tail.txt": "first\nsecond updated\n" },
	},
	{
		name: "023_preserves_crlf_line_endings",
		input: { "lines.txt": "one\r\ntwo\r\nthree\r\n" },
		patch: "*** Update File: lines.txt\n@@\n-one\n+ONE\n two\n+between\n three",
		expected: { "lines.txt": "ONE\r\ntwo\r\nbetween\r\nthree\r\n" },
	},
	{
		name: "024_preserves_mixed_line_endings",
		input: { "lines.txt": "one\r\ntwo\rthree\nfour\r\n" },
		patch: "*** Update File: lines.txt\n@@\n one\n two\n-three\n+THREE\n four",
		expected: { "lines.txt": "one\r\ntwo\rTHREE\r\nfour\r\n" },
	},
];

function snapshot(root: string, prefix = ""): Snapshot {
	const result: Snapshot = {};
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		const key = prefix + entry.name;
		if (entry.isDirectory()) {
			result[`${key}/`] = null;
			Object.assign(result, snapshot(path, `${key}/`));
		} else result[key] = readFileSync(path, "utf8");
	}
	return result;
}

for (const scenario of scenarios) {
	test(`Codex scenario: ${scenario.name}`, async (t) => {
		const cwd = mkdtempSync(join(tmpdir(), "code-mode-codex-scenario-"));
		t.after(() => rmSync(cwd, { recursive: true, force: true }));
		for (const [name, content] of Object.entries(scenario.input)) {
			const path = join(cwd, name);
			mkdirSync(content === null ? path : dirname(path), { recursive: true });
			if (content !== null) writeFileSync(path, content);
		}
		const patch = scenario.patch.includes("*** Begin Patch")
			? scenario.patch
			: `*** Begin Patch\n${scenario.patch ? `${scenario.patch}\n` : ""}*** End Patch\n`;
		// Upstream scenarios explicitly select preservation mode, not the legacy default.
		const run = () => applyPatch(cwd, patch, undefined, "preserveLineEndings");
		if (scenario.fails) await assert.rejects(run);
		else await run();
		assert.deepEqual(snapshot(cwd), scenario.expected);
	});
}
