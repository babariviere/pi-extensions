import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NIGHT_CATEGORIES, planProblems, formatApprovedPlan } from "./plan.ts";
import { composePlanningPrompt } from "./prompt.ts";

const task = {
	title: "Check vllm",
	category: "instructions",
	goal: "Read configuration",
	repository: "/repo",
	definitionOfDone: "Return diagnosis",
	outputs: [],
	permissions: [],
};
const omissions = NIGHT_CATEGORIES.filter((category) => category !== "instructions").map((category) => ({
	category,
	reason: "Explicitly excluded tonight",
}));
describe("night routine coverage", () => {
	it("rejects a narrow extra instruction that silently replaces the routine", () => {
		const problems = planProblems([task], [], true);
		assert.equal(problems.length, 7);
		for (const category of ["slack", "daily-note", "insights"])
			assert.ok(problems.some((problem) => problem.includes(category)));
	});
	it("accepts explained omissions and read-only tasks", () => {
		assert.deepEqual(planProblems([task], omissions, true), []);
		assert.ok(
			planProblems(
				[task],
				omissions.map((item) => ({ ...item, reason: " " })),
				true,
			).length,
		);
	});
	it("rejects incomplete authorization and unknown categories", () => {
		assert.ok(
			planProblems([{ ...task, outputs: undefined }], omissions, true).some((problem) =>
				problem.includes("outputs"),
			),
		);
		assert.ok(
			planProblems([{ ...task, category: "typo" }], omissions, true).some((problem) =>
				problem.includes("valid category"),
			),
		);
	});
	it("checks MCP policy without widening it", () => {
		const write = { ...task, permissions: ["mcp-write"] };
		assert.ok(planProblems([write], omissions, true).some((problem) => problem.includes("MCP writes are disabled")));
		assert.deepEqual(planProblems([write], omissions, false), []);
	});
	it("preserves briefs, capabilities and authorization in the execution prompt", () => {
		const text = formatApprovedPlan([
			{
				...task,
				id: "123",
				briefs: ["/brief.md"],
				needs: ["gh-auth"],
				outputs: ["/note.md"],
				permissions: ["note-write"],
			},
		]);
		for (const value of ["/brief.md", "gh-auth", "/note.md", "note-write"]) assert.ok(text.includes(value));
	});
	it("separates planner authority from execution-only reference rules", () => {
		const text = composePlanningPrompt({
			prompt: "Planning already happened. Never discover work.",
			instructions: "Check vllm",
			windowLabel: "21:00-09:00",
		});
		assert.match(text, /apply AFTER approval/);
		assert.match(text, /Extra instructions supplement the routine/);
		assert.match(text, /Always propose Slack scan/);
		assert.match(text, /validation rejects it/);
		for (const category of NIGHT_CATEGORIES) assert.ok(text.includes(category));
	});
});
