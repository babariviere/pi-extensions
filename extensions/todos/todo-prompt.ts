const TODO_DIR_NAME = ".pi/todos";

/** Update the todo-owned section and remove it when no open items remain. */
export function updateTodoPromptSection(
	sections: Record<string, string>,
	openCount: number,
	assignedCount: number,
): void {
	if (openCount === 0) {
		delete sections.todo_tracking;
		return;
	}

	sections.todo_tracking = [
		"## Todo tracking",
		`There ${openCount === 1 ? "is" : "are"} ${openCount} open todo${openCount === 1 ? "" : "s"} in ${TODO_DIR_NAME} for this repo${assignedCount ? `, ${assignedCount} assigned to this session` : ""}.`,
		"Use the native todo tools to track multi-step or multi-session work.",
	].join("\n");
}
