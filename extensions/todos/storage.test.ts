import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it } from "node:test";
import { createTodo, serializeTodo } from "./storage.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("createTodo writes the format consumed by the todo extension", async () => {
	const dir = mkdtempSync(join(tmpdir(), "todo-storage-"));
	roots.push(dir);
	const todo = await createTodo(dir, {
		title: "Approved task",
		tags: ["night", "night-approved"],
		body: "Exact scope",
		needs: ["gh-auth"],
		createdAt: new Date("2026-09-05T20:00:00.000Z"),
	});
	const content = readFileSync(join(dir, `${todo.id}.md`), "utf8");
	assert.equal(content, serializeTodo(todo));
	assert.match(content, /"needs": \[/);
	assert.match(content, /Exact scope/);
});
