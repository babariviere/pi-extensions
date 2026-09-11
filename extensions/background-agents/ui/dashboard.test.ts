import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { DashboardSnapshot } from "../types.ts";
import { BackgroundDashboard, type DashboardClient } from "./dashboard.ts";
import { buildDashboardViewLines, DASHBOARD_VIEWS } from "./views.ts";

const snapshot: DashboardSnapshot = {
	cases: [
		{
			id: "case-1",
			title: "Cache misses",
			source: "manual",
			state: "verification",
			repository: "demo",
			rollout: "supervised",
			createdAt: "2026-01-01T00:00:00Z",
			updatedAt: "2026-01-01T00:00:00Z",
		},
	],
	attempts: [
		{
			id: "attempt-1",
			caseId: "case-1",
			role: "verifier",
			generation: 1,
			state: "running",
			profileId: "profile-1",
			model: "model-1",
			branch: "background/case-1/1",
			worktree: "/tmp/worktree",
		},
	],
	profiles: [
		{
			id: "profile-1",
			provider: "anthropic",
			allowedModels: [],
			allowedRoles: ["verifier"],
			maxBackgroundAttempts: 1,
			interactiveReserve: 1,
			usageStaleAfterMs: 1_000,
		},
	],
	workItems: [],
	stacks: [],
	classifications: [],
	policies: [],
	memory: [],
	specifications: [],
	approvals: [],
	feedback: [],
	questionBriefs: [],
	artifacts: [],
	jobs: [],
	usage: [],
	evidenceManifests: [
		{
			id: "manifest-1",
			caseId: "case-1",
			version: 1,
			baseSha: "base",
			candidateSha: "candidate",
			commands: [],
			createdAt: "2026-01-01T00:00:00Z",
			toolVersions: {},
		},
	],
	verificationRuns: [],
	system: {
		started: true,
		activeAttempts: 1,
		queuedJobs: 0,
		controller: "connected",
		socketMode: 0o600,
		socketMaxRequestBytes: 1_048_576,
	},
	rollout: "supervised",
	emergencyStop: false,
	generatedAt: "2026-01-01T00:00:00Z",
};

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function fakeTui() {
	return { requestRender() {} } as never;
}

test("renders every operator view with provenance, evidence, and artifact references", () => {
	for (const view of DASHBOARD_VIEWS) {
		const lines = buildDashboardViewLines(snapshot, view);
		assert.ok(lines.length > 1, view);
	}
	const evidence = buildDashboardViewLines(snapshot, "evidence").join("\n");
	assert.match(evidence, /Manifest manifest-1/);
	assert.match(buildDashboardViewLines(snapshot, "attempt").join("\n"), /Artifact references/);
});

test("refreshes through the client, renders narrow terminals, and reproduces evidence", async () => {
	let refreshes = 0;
	let reproduced: string | undefined;
	const client: DashboardClient = {
		async getDashboard() {
			refreshes += 1;
			return snapshot;
		},
		async action() {},
		async reproduce(_caseId, manifest) {
			reproduced = manifest;
		},
	};
	let closed = false;
	const dashboard = new BackgroundDashboard(
		fakeTui(),
		theme,
		() => {
			closed = true;
		},
		{ client },
	);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(refreshes, 1);
	assert.ok(dashboard.render(28).length > 0);
	dashboard.handleInput("R");
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(reproduced, "manifest-1");
	dashboard.handleInput("escape");
	assert.equal(closed, true);
});

test("shows controller outage without throwing", async () => {
	const dashboard = new BackgroundDashboard(fakeTui(), theme, () => {}, {
		client: {
			getDashboard: async () => {
				throw new Error("socket unavailable");
			},
			action: async () => {},
			reproduce: async () => {},
		},
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.match(dashboard.render(100).join("\n"), /Controller outage: socket unavailable/);
});
