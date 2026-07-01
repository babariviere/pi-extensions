import assert from "node:assert/strict";
import { test } from "node:test";
import { isValidName, parseHerdrWorkspaces } from "./index.ts";

test("isValidName accepts safe names, rejects the rest", () => {
	assert.ok(isValidName("feature-x"));
	assert.ok(isValidName("feat_1.2"));
	assert.ok(!isValidName("has space"));
	assert.ok(!isValidName("a/b"));
	assert.ok(!isValidName(""));
});

test("parseHerdrWorkspaces tolerates field-name variation", () => {
	assert.deepEqual(parseHerdrWorkspaces(undefined), []);

	const fromWorkspaces = parseHerdrWorkspaces({
		workspaces: [
			{ id: "w1", cwd: "/a", label: "api" },
			{ workspace_id: "w2", path: "/b" },
			{ id: "w3" }, // no cwd -> dropped
		],
	});
	assert.deepEqual(fromWorkspaces, [
		{ id: "w1", cwd: "/a", label: "api" },
		{ id: "w2", cwd: "/b", label: undefined },
	]);

	const fromList = parseHerdrWorkspaces({ list: [{ workspaceId: "x", working_directory: "/c" }] });
	assert.deepEqual(fromList, [{ id: "x", cwd: "/c", label: undefined }]);
});
