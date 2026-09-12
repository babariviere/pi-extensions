import assert from "node:assert/strict";
import { test } from "node:test";

import { filterCapturedToolVisibility } from "./interceptor.ts";

const registered = (name: string, path: string) => ({ definition: { name }, sourceInfo: { path } }) as any;

const tools = [
	registered("code_mode", "/code-mode/index.ts"),
	registered("web_search", "/web/index.ts"),
	registered("fetch_content", "/web/index.ts"),
	registered("read", "/tool-substitute/index.ts"),
	registered("todo", "/todos/index.ts"),
	registered("ask", "/ask/index.ts"),
];

test("capture hides every tool except code_mode", () => {
	const visible = filterCapturedToolVisibility(tools, "/code-mode/index.ts", {
		enabled: true,
		hideFromModel: true,
		keepVisible: ["code_mode"],
	});
	assert.deepEqual(
		visible.map((tool) => tool.definition.name),
		["code_mode"],
	);
});

test("keepVisible restores a deliberately retained selected tool", () => {
	const visible = filterCapturedToolVisibility(tools, "/code-mode/index.ts", {
		enabled: true,
		hideFromModel: true,
		keepVisible: ["code_mode", "todo", "web_search"],
	});
	assert.deepEqual(
		visible.map((tool) => tool.definition.name),
		["code_mode", "web_search", "todo"],
	);
});

test("disabled or direct-visibility capture leaves every native tool alone", () => {
	for (const policy of [
		{ enabled: false, hideFromModel: true, keepVisible: [] },
		{ enabled: true, hideFromModel: false, keepVisible: [] },
	]) {
		assert.deepEqual(filterCapturedToolVisibility(tools, "/code-mode/index.ts", policy), tools);
	}
});
