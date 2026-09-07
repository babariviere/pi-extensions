import { createTodo } from "../todos/storage.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { NIGHT_TAG, runTag } from "./ledger.ts";

export const NIGHT_PLAN_HANDOFF_ENTRY = "night-mode:approved-plan";
export const NIGHT_PLAN_STARTED_ENTRY = "night-mode:approved-plan-started";
export const APPROVED_TAG = "night-approved";

export const NIGHT_CATEGORIES = [
	"instructions",
	"linear",
	"ci",
	"slack",
	"daily-note",
	"opportunistic",
	"insights",
	"auto-improvement",
] as const;

export const NightCoverageSchema = Type.Object({
	category: Type.String(),
	reason: Type.String({
		description:
			"Why this category has no proposed task: no findings, blocked, not applicable, or explicitly excluded",
	}),
});
export interface NightCoverage {
	category: string;
	reason: string;
}

export function planProblems(tasks: NightPlanTask[], omissions: NightCoverage[], mcpReadOnly: boolean): string[] {
	const problems: string[] = [];
	for (const omission of omissions) {
		if (!NIGHT_CATEGORIES.some((category) => category === omission.category))
			problems.push(`Unknown omitted category: ${omission.category}`);
		if (tasks.some((task) => task.category === omission.category))
			problems.push(`${omission.category}: cannot both propose tasks and omit the category.`);
	}
	for (const category of NIGHT_CATEGORIES) {
		if (
			!tasks.some((task) => task.category === category) &&
			!omissions.some((item) => item.category === category && item.reason.trim())
		)
			problems.push(`Missing routine category: ${category}. Propose a task or explain its omission.`);
	}
	for (const task of tasks) {
		if (!validTask(task)) {
			problems.push("Task fields must be nonempty strings and metadata must be string arrays.");
			continue;
		}
		if (!NIGHT_CATEGORIES.some((category) => category === task.category))
			problems.push(`${task.title}: specify a valid category.`);
		if (!task.outputs || !task.permissions)
			problems.push(`${task.title}: specify outputs and permissions (empty arrays for read-only work).`);
		if (mcpReadOnly && task.permissions?.some((permission) => permission.trim() === "mcp-write"))
			problems.push(
				`${task.title}: MCP writes are disabled. Propose a candidate-only result or change configuration before planning.`,
			);
	}
	return problems;
}

export const NightPlanTaskSchema = Type.Object({
	category: Type.Optional(Type.String({ description: `Routine category: ${NIGHT_CATEGORIES.join(", ")}` })),
	outputs: Type.Optional(
		Type.Array(Type.String({ description: "Exact permitted output paths or repository working-copy scope" })),
	),
	permissions: Type.Optional(
		Type.Array(
			Type.String({
				description:
					"Explicit approved operations, e.g. draft-pr, queue-update, note-write, mcp-write. Empty for reads only. Does not override sandbox policy.",
			}),
		),
	),
	title: Type.String({ description: "Short, specific task title" }),
	goal: Type.String({ description: "Exact scope and intended outcome" }),
	repository: Type.String({ description: "Absolute repository or workspace path" }),
	definitionOfDone: Type.String({ description: "Observable completion criteria" }),
	briefs: Type.Optional(Type.Array(Type.String({ description: "Context files the worker should read" }))),
	needs: Type.Optional(Type.Array(Type.String({ description: "Capabilities required to complete the task" }))),
	findings: Type.Optional(Type.String({ description: "Relevant evidence found while planning" })),
});

export interface NightPlanTask {
	category?: string;
	outputs?: string[];
	permissions?: string[];
	title: string;
	goal: string;
	repository: string;
	definitionOfDone: string;
	briefs?: string[];
	needs?: string[];
	findings?: string;
}

export interface ApprovedNightTask extends NightPlanTask {
	id: string;
}

export interface NightPlanHandoff {
	version: 1;
	planningSession?: string;
	planningStartedAt: number;
	/** Missing on legacy handoffs, which start immediately. */
	scheduledStartAt?: number;
	windowLabel: string;
	cwd: string;
	prompt: string;
	instructions: string;
	tasks: NightPlanTask[];
}

type ReviewAction =
	| { action: "approve" }
	| { action: "edit"; index: number }
	| { action: "add" }
	| { action: "delete"; index: number }
	| { action: "cancel" };

function normalizedTask(task: NightPlanTask): NightPlanTask {
	return {
		title: task.title.trim(),
		...(task.category ? { category: task.category.trim() } : {}),
		...(task.outputs ? { outputs: task.outputs.map((value) => value.trim()).filter(Boolean) } : {}),
		...(task.permissions ? { permissions: task.permissions.map((value) => value.trim()).filter(Boolean) } : {}),
		goal: task.goal.trim(),
		repository: task.repository.trim(),
		definitionOfDone: task.definitionOfDone.trim(),
		...(task.briefs?.map((value) => value.trim()).filter(Boolean).length
			? { briefs: task.briefs.map((value) => value.trim()).filter(Boolean) }
			: {}),
		...(task.needs?.map((value) => value.trim()).filter(Boolean).length
			? { needs: task.needs.map((value) => value.trim()).filter(Boolean) }
			: {}),
		...(task.findings?.trim() ? { findings: task.findings.trim() } : {}),
	};
}

function validTask(value: unknown): value is NightPlanTask {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const task = value as Record<string, unknown>;
	if (task.category !== undefined && typeof task.category !== "string") return false;
	for (const key of ["briefs", "needs", "outputs", "permissions"]) {
		if (
			task[key] !== undefined &&
			(!Array.isArray(task[key]) || !(task[key] as unknown[]).every((value) => typeof value === "string"))
		)
			return false;
	}
	if (task.findings !== undefined && typeof task.findings !== "string") return false;
	return ["title", "goal", "repository", "definitionOfDone"].every(
		(key) => typeof task[key] === "string" && Boolean((task[key] as string).trim()),
	);
}

async function editTask(ctx: ExtensionContext, task?: NightPlanTask): Promise<NightPlanTask | undefined> {
	const initial = task ?? {
		title: "",
		goal: "",
		repository: ctx.cwd,
		definitionOfDone: "",
	};
	const edited = await ctx.ui.editor("Refine night task as JSON", JSON.stringify(initial, null, 2));
	if (edited === undefined) return task;
	try {
		const parsed: unknown = JSON.parse(edited);
		if (!validTask(parsed)) throw new Error("title, goal, repository and definitionOfDone must be non-empty strings");
		return normalizedTask(parsed);
	} catch (error) {
		ctx.ui.notify(`night-mode: invalid task: ${String(error)}`, "error");
		return task;
	}
}

/** Review a planner-produced list. Nothing is selected until the user explicitly checks it. */
export async function reviewNightPlan(
	ctx: ExtensionContext,
	proposed: NightPlanTask[],
	omissions: NightCoverage[] = [],
	mcpReadOnly = true,
): Promise<NightPlanTask[] | null> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("night-mode: approving a plan requires the interactive TUI", "error");
		return null;
	}
	const tasks = proposed.filter(validTask).map(normalizedTask);
	const selected = tasks.map(() => false);

	while (true) {
		const result = await ctx.ui.custom<ReviewAction>((tui, theme, _keybindings, done) => {
			let index = Math.min(Math.max(0, tasks.length - 1), 0);
			let cached: string[] | undefined;
			const refresh = () => {
				cached = undefined;
				tui.requestRender();
			};
			return {
				render(width: number): string[] {
					if (cached) return cached;
					const lines: string[] = [theme.fg("accent", "─".repeat(Math.max(1, width)))];
					const add = (prefix: string, text: string) => {
						const continuation = " ".repeat(visibleWidth(prefix));
						wrapTextWithAnsi(text, Math.max(1, width - visibleWidth(prefix))).forEach((line, lineIndex) =>
							lines.push(`${lineIndex === 0 ? prefix : continuation}${line}`),
						);
					};
					add(" ", theme.bold("Approve tonight's work"));
					lines.push("");
					for (const item of omissions)
						add(" ", theme.fg("warning", `Not proposed: ${item.category}: ${item.reason}`));
					if (tasks.length === 0) add(" ", theme.fg("warning", "No tasks in the plan."));
					tasks.forEach((task, taskIndex) => {
						const current = taskIndex === index;
						const arrow = current ? theme.fg("accent", ">") : " ";
						const box = selected[taskIndex] ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
						add(`${arrow} ${box} `, theme.fg(current ? "accent" : "text", task.title));
						add("      ", theme.fg("muted", `${task.repository} · ${task.definitionOfDone}`));
						add("      ", `Scope: ${task.goal}`);
						add(
							"      ",
							`Outputs: ${task.outputs?.join(", ") || "none"}; permissions: ${task.permissions?.join(", ") || "read-only"}`,
						);
					});
					lines.push("");
					add(
						" ",
						theme.fg(
							"dim",
							"↑↓ move · space toggle · e edit · n add · d delete · a all/none · enter approve · esc cancel",
						),
					);
					lines.push(theme.fg("accent", "─".repeat(Math.max(1, width))));
					cached = lines;
					return lines;
				},
				invalidate() {
					cached = undefined;
				},
				handleInput(data: string) {
					if (matchesKey(data, Key.up)) {
						index = Math.max(0, index - 1);
						refresh();
					} else if (matchesKey(data, Key.down)) {
						index = Math.min(tasks.length - 1, index + 1);
						refresh();
					} else if (data === " " && tasks[index]) {
						selected[index] = !selected[index];
						refresh();
					} else if ((data === "e" || data === "E") && tasks[index]) done({ action: "edit", index });
					else if (data === "n" || data === "N") done({ action: "add" });
					else if ((data === "d" || data === "D") && tasks[index]) done({ action: "delete", index });
					else if (data === "a" || data === "A") {
						selected.fill(!selected.every(Boolean));
						refresh();
					} else if (matchesKey(data, Key.enter)) done({ action: "approve" });
					else if (matchesKey(data, Key.escape)) done({ action: "cancel" });
				},
			};
		});

		if (result.action === "cancel") return null;
		if (result.action === "edit") {
			const edited = await editTask(ctx, tasks[result.index]);
			if (edited) tasks[result.index] = edited;
			continue;
		}
		if (result.action === "add") {
			const added = await editTask(ctx);
			if (added) {
				tasks.push(added);
				selected.push(false);
			}
			continue;
		}
		if (result.action === "delete") {
			tasks.splice(result.index, 1);
			selected.splice(result.index, 1);
			continue;
		}
		const approved = tasks.filter((_, taskIndex) => selected[taskIndex]);
		if (approved.length === 0) {
			ctx.ui.notify("night-mode: check at least one task, or press Esc to cancel", "warning");
			continue;
		}
		const problems = planProblems(
			approved,
			NIGHT_CATEGORIES.filter((category) => !approved.some((task) => task.category === category)).map(
				(category) => ({ category, reason: "Excluded in user review" }),
			),
			mcpReadOnly,
		);
		if (problems.length) {
			ctx.ui.notify(problems.join("\n"), "error");
			continue;
		}
		return approved;
	}
}

/** Materialize exactly the approved tasks through the todo extension's shared storage layer. */
export async function seedApprovedLedger(
	dir: string,
	runId: string,
	tasks: NightPlanTask[],
	now = new Date(),
): Promise<ApprovedNightTask[]> {
	const approved: ApprovedNightTask[] = [];
	for (const task of tasks) {
		const normalized = normalizedTask(task);
		const body = [
			"## Goal",
			normalized.goal,
			"",
			`Repository: ${normalized.repository}`,
			"",
			`Category: ${normalized.category ?? "legacy"}`,
			`Permitted outputs: ${normalized.outputs?.join(", ") || "none specified"}`,
			`Approved operations: ${normalized.permissions ? normalized.permissions.join(", ") || "read-only" : "legacy: follow approved scope"}`,
			"",
			"## Definition of done",
			normalized.definitionOfDone,
			...(normalized.briefs?.length ? ["", "## Read first", ...normalized.briefs.map((path) => `- ${path}`)] : []),
			...(normalized.findings ? ["", "## Planning findings", normalized.findings] : []),
			"",
		].join("\n");
		const todo = await createTodo(dir, {
			title: normalized.title,
			tags: [NIGHT_TAG, runTag(runId), APPROVED_TAG],
			status: "open",
			body,
			createdAt: now,
			needs: normalized.needs,
		});
		approved.push({ ...normalized, id: todo.id });
	}
	return approved;
}

export function formatApprovedPlan(tasks: ApprovedNightTask[]): string {
	return tasks
		.map(
			(task, index) =>
				`${index + 1}. TODO-${task.id} ${task.title}\n` +
				`   Repository: ${task.repository}\n` +
				`   Goal: ${task.goal}\n` +
				`   Done when: ${task.definitionOfDone}` +
				`\n   Read first: ${task.briefs?.join(", ") || "none"}` +
				`\n   Needs: ${task.needs?.join(", ") || "none"}` +
				`\n   Permitted outputs: ${task.outputs?.join(", ") || "none specified"}` +
				`\n   Approved operations: ${task.permissions ? task.permissions.join(", ") || "read-only" : "legacy: follow approved scope"}` +
				(task.findings ? `\n   Planning findings: ${task.findings}` : ""),
		)
		.join("\n\n");
}
