import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { CodeModeState } from "../code-mode-state.ts";
import { createDashboardSnapshot } from "./snapshot.ts";
import { CodeModeWidget, shouldShowCodeModeWidget } from "./widget.ts";
import type { CodeModeDashboardSnapshot } from "./types.ts";

const theme = { fg: (_color: string, value: string) => value } as Theme;

test("running jobs keep the widget visible and render their names and handles", () => {
	const snapshot: CodeModeDashboardSnapshot = {
		now: 10_000,
		agents: [],
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
	assert.match(lines[0] ?? "", /background work · 1 job/);
	assert.match(lines[1] ?? "", /Docs preview.*job 12345678.*2s/);
	const busy = {
		...snapshot,
		agents: Array.from({ length: 8 }, (_, index) => ({
			id: String(index),
			name: `agent ${index}`,
			status: "running",
		})),
	};
	assert.match(new CodeModeWidget(theme, () => busy, 2).render(100)[1] ?? "", /Docs preview/);
	assert.equal(shouldShowCodeModeWidget({ ...snapshot, jobs: [] }, "auto"), false);
});

test("subagents are shown, but ordinary Code Mode activity never mounts the widget", () => {
	const state = {
		activity: { runs: () => [{ id: "program", status: "running", name: "Code Mode program" }] },
		agentRuns: { list: () => [] },
		runningJobs: () => [],
	} as unknown as CodeModeState;
	const idle = createDashboardSnapshot(state);
	assert.equal(shouldShowCodeModeWidget(idle, "auto"), false);
	state.agentRuns.list = () => [
		{ id: "agent-1", name: "reviewer", status: "running", startedAt: 1_000, updatedAt: 3_000 },
	];
	const active = createDashboardSnapshot(state);
	assert.equal(shouldShowCodeModeWidget(active, "auto"), true);
	assert.match(new CodeModeWidget(theme, () => active, 6).render(100)[1] ?? "", /reviewer.*thinking/);
});
