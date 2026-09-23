import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { CodeModeActivityRun } from "../activity/types.ts";
import { CodeModeActivityStore } from "../activity/store.ts";
import type { CodeModeState } from "../code-mode-state.ts";
import { createDashboardSnapshot } from "./snapshot.ts";
import { CodeModeWidget, shouldShowCodeModeWidget } from "./widget.ts";
import type { CodeModeDashboardSnapshot } from "./types.ts";

const theme = { fg: (_color: string, value: string) => value } as Theme;
const run = (id: string, status: CodeModeActivityRun["status"] = "running"): CodeModeActivityRun => ({
	id,
	name: "Code Mode program",
	status,
	startedAt: 1_000,
	updatedAt: 5_000,
	phases: [],
	calls: [],
	items: [],
	events: [],
});

test("running jobs keep the Code Mode widget visible and render their names and handles", () => {
	const snapshot: CodeModeDashboardSnapshot = {
		now: 10_000,
		runs: [],
		agents: [],
		actors: [],
		jobs: [
			{
				id: "12345678-abcdef",
				name: "Docs preview",
				state: "running",
				startedAt: 8_000,
				outputPath: "/tmp/job.log",
			},
		],
	};
	assert.equal(shouldShowCodeModeWidget(snapshot, "auto"), true);
	const lines = new CodeModeWidget(theme, () => snapshot, 10).render(100);
	assert.match(lines[0] ?? "", /Code Mode session · 1 job/);
	assert.match(lines[1] ?? "", /Docs preview.*job 12345678.*2s/);
	const busy = {
		...snapshot,
		agents: Array.from({ length: 8 }, (_, index) => ({
			id: String(index),
			name: `agent ${index}`,
			status: "running",
		})),
	};
	const compact = new CodeModeWidget(theme, () => busy, 2).render(100);
	assert.match(compact[1] ?? "", /Docs preview/);
	assert.equal(shouldShowCodeModeWidget({ ...snapshot, jobs: [] }, "auto"), false);
});

test("the widget shows the running program, its active call, then the final call", () => {
	let current: CodeModeDashboardSnapshot = { now: 5_000, runs: [run("current")], agents: [], jobs: [], actors: [] };
	const widget = new CodeModeWidget(theme, () => current, 6);
	assert.match(widget.render(100)[1] ?? "", /Running TypeScript/);
	const call = {
		id: "call-1",
		ref: "pi.bash",
		label: "pi.bash · npm run typecheck",
		kind: "tool" as const,
		status: "running" as const,
		progress: "Checking files",
		startedAt: 2_000,
		updatedAt: 5_000,
	};
	current = { ...current, runs: [{ ...run("current"), calls: [call] }] };
	assert.equal(widget.hasChanged(), true);
	assert.match(widget.render(100)[1] ?? "", /pi.bash · npm run typecheck.*Checking files.*3s/);
	current = {
		...current,
		runs: [{ ...run("current", "completed"), calls: [{ ...call, status: "completed", finishedAt: 5_000 }] }],
	};
	assert.match(widget.render(100)[1] ?? "", /pi.bash · npm run typecheck/);
});

test("a running program takes precedence over an older run with a detached subagent", () => {
	const old = run("old", "completed");
	const current = run("current");
	const state = {
		widgetDismissedAt: 0,
		activity: { runs: () => [old, current] },
		agentRuns: {
			list: () => [
				{ id: "agent-1", name: "reviewer", status: "running", runId: "old", startedAt: 2_000, updatedAt: 3_000 },
			],
		},
		runningJobs: () => [],
	} as unknown as CodeModeState;
	const snapshot = createDashboardSnapshot(state);
	assert.equal(snapshot.runs[0]?.id, "current");
	assert.match(new CodeModeWidget(theme, () => snapshot, 6).render(100)[1] ?? "", /Running TypeScript/);
});

test("nested calls from the live activity store reach the widget", () => {
	const activity = new CodeModeActivityStore();
	activity.start("tool-call-1");
	activity.beginCall("tool-call-1", { callId: "nested-1", ref: "pi.bash", args: { command: "npm test" } });
	const state = {
		widgetDismissedAt: 0,
		activity,
		agentRuns: { list: () => [] },
		runningJobs: () => [],
	} as unknown as CodeModeState;
	const snapshot = createDashboardSnapshot(state);
	assert.match(new CodeModeWidget(theme, () => snapshot, 6).render(100)[1] ?? "", /pi.bash · npm test/);
});
