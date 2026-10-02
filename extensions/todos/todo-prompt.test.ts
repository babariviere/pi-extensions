import assert from "node:assert/strict";
import { test } from "node:test";
import { updateTodoPromptSection } from "./todo-prompt.ts";

test("todo prompt names the available tools in a mutable section", () => {
	const sections: Record<string, string> = { preamble: "Base" };
	updateTodoPromptSection(sections, 2, 1);
	assert.equal(sections.preamble, "Base");
	assert.match(sections.todo_tracking, /2 open todos/);
	assert.match(sections.todo_tracking, /1 assigned to this session/);
});

test("todo prompt clears its section when no open todos remain", () => {
	const sections: Record<string, string> = { preamble: "Base", todo_tracking: "stale" };
	updateTodoPromptSection(sections, 0, 0);
	assert.deepEqual(sections, { preamble: "Base" });
});
