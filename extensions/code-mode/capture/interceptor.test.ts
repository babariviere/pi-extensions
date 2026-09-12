import assert from "node:assert/strict";
import { test } from "node:test";

import { filterCapturedToolVisibility } from "./interceptor.ts";

const registered = (name: string, path: string) => ({ definition: { name }, sourceInfo: { path } }) as any;

const tools = [
	registered("code_mode", "/spindle/index.ts"),
	registered("web_search", "/web/index.ts"),
	registered("fetch_content", "/web/index.ts"),
	registered("read", "/tool-substitute/index.ts"),
	registered("todo", "/todos/index.ts"),
	registered("ask", "/ask/index.ts"),
];

test("capture hides selected capabilities and core overrides, not unrelated siblings", () => {
	const visible = filterCapturedToolVisibility(
		tools,
		"/spindle/index.ts",
		{ enabled: true, hideFromModel: true, keepVisible: ["code_mode"] },
		["web_search", "fetch_content", "read"],
	);
	assert.deepEqual(
		visible.map((tool) => tool.definition.name),
		["code_mode", "todo", "ask"],
	);
});

test("keepVisible restores a deliberately retained selected tool", () => {
	const visible = filterCapturedToolVisibility(
		tools,
		"/spindle/index.ts",
		{ enabled: true, hideFromModel: true, keepVisible: ["code_mode", "todo", "web_search"] },
		["web_search", "fetch_content", "read"],
	);
	assert.deepEqual(
		visible.map((tool) => tool.definition.name),
		["code_mode", "web_search", "todo", "ask"],
	);
});

test("disabled or direct-visibility capture leaves every native tool alone", () => {
	for (const policy of [
		{ enabled: false, hideFromModel: true, keepVisible: [] },
		{ enabled: true, hideFromModel: false, keepVisible: [] },
	]) {
		assert.deepEqual(filterCapturedToolVisibility(tools, "/spindle/index.ts", policy, ["web_search"]), tools);
	}
});
