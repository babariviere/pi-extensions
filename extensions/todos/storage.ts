import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { join } from "node:path";

export interface TodoFrontMatter {
	id: string;
	title: string;
	tags: string[];
	status: string;
	created_at: string;
	assigned_to_session?: string;
	needs?: string[];
}

export interface TodoRecord extends TodoFrontMatter {
	body: string;
}

export interface CreateTodoInput {
	title: string;
	tags?: string[];
	status?: string;
	body?: string;
	needs?: string[];
	createdAt?: Date;
}

export function todoPath(todosDir: string, id: string): string {
	return join(todosDir, `${id}.md`);
}

export function serializeTodo(todo: TodoRecord): string {
	const frontMatter = JSON.stringify(
		{
			id: todo.id,
			title: todo.title,
			tags: todo.tags ?? [],
			status: todo.status,
			created_at: todo.created_at,
			assigned_to_session: todo.assigned_to_session || undefined,
			...(todo.needs?.length ? { needs: todo.needs } : {}),
		},
		null,
		2,
	);
	const trimmedBody = (todo.body ?? "").replace(/^\n+/, "").replace(/\s+$/, "");
	return trimmedBody ? `${frontMatter}\n\n${trimmedBody}\n` : `${frontMatter}\n`;
}

export async function ensureTodosDir(todosDir: string): Promise<void> {
	await fs.mkdir(todosDir, { recursive: true });
}

export async function generateTodoId(todosDir: string): Promise<string> {
	for (let attempt = 0; attempt < 10; attempt += 1) {
		const id = randomBytes(4).toString("hex");
		if (!existsSync(todoPath(todosDir, id))) return id;
	}
	throw new Error("Failed to generate unique todo id");
}

/** Create a todo atomically. This is shared by the todo tool and host-owned workflows such as night approval. */
export async function createTodo(todosDir: string, input: CreateTodoInput): Promise<TodoRecord> {
	await ensureTodosDir(todosDir);
	for (let attempt = 0; attempt < 10; attempt += 1) {
		const id = await generateTodoId(todosDir);
		const todo: TodoRecord = {
			id,
			title: input.title,
			tags: input.tags ?? [],
			status: input.status ?? "open",
			created_at: (input.createdAt ?? new Date()).toISOString(),
			body: input.body ?? "",
			...(input.needs?.length ? { needs: input.needs } : {}),
		};
		try {
			await fs.writeFile(todoPath(todosDir, id), serializeTodo(todo), { encoding: "utf8", flag: "wx" });
			return todo;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
	throw new Error("Failed to create todo after repeated id collisions");
}
