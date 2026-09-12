import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { normalizeBackgroundAgentsConfig } from "../../config.ts";
import { BackgroundAgentsDatabase } from "../database.ts";
import { buildContextManifest } from "./context.ts";
import { launchAttemptThroughHerdr } from "./herdr.ts";
import { prepareRuntimeProfile, selectRuntimeProfile } from "./profiles.ts";

test("persists context and launch metadata while keeping secrets out of pane argv", async () => {
	const root = mkdtempSync(join(tmpdir(), "background-runtime-herdr-"));
	const database = new BackgroundAgentsDatabase(":memory:");
	try {
		const primary = join(root, "primary");
		const worktree = join(root, "worktree");
		const attempt = join(root, "attempt");
		mkdirSync(join(primary, ".git"), { recursive: true });
		mkdirSync(worktree);
		mkdirSync(attempt);
		const auth = join(root, "auth.json");
		writeFileSync(auth, '{"token":"not-in-command"}');
		chmodSync(auth, 0o600);
		const config = normalizeBackgroundAgentsConfig({
			profiles: [{ id: "p", provider: "anthropic", agentDir: root, authFiles: [auth], allowedModels: ["model"] }],
		});
		const runtime = prepareRuntimeProfile(selectRuntimeProfile(config, "worker", { attemptDir: attempt }));
		const caseId = database.createCase({ title: "launch", source: "manual" });
		const jobId = database.createJob({ caseId, role: "worker" });
		const claim = database.claimJob(jobId, "controller")!;
		const calls: string[][] = [];
		const result = await launchAttemptThroughHerdr(
			{
				database,
				attemptId: claim.attemptId,
				caseId,
				role: "worker",
				attemptDirectory: attempt,
				worktreeDirectory: worktree,
				primaryCheckout: primary,
				gitDirectory: join(primary, ".git"),
				context: buildContextManifest({
					attemptId: claim.attemptId,
					caseId,
					role: "worker",
					context: { instruction: "work" },
				}),
				runtime,
				rolePromptPath: join(root, "worker.md"),
				limits: config.systemd,
			},
			{
				preflight: async () => {},
				herdr: {
					createTab: async () => ({ tabId: "tab", rootPaneId: "pane" }),
					waitForShellReady: async () => ({ ok: true }),
					runCommand: async (_pane, argv) => {
						const pending = database.get<{ systemd_unit: string; tab_id: string; pane_id: string }>(
							"SELECT systemd_unit, tab_id, pane_id FROM attempts WHERE id = ?",
							claim.attemptId,
						);
						assert.equal(pending?.systemd_unit, `background-agent-${claim.attemptId}`);
						assert.equal(pending?.tab_id, "tab");
						assert.equal(pending?.pane_id, "pane");
						calls.push(argv);
						return { ok: true };
					},
					closeTab: async () => {},
				},
			},
		);
		assert.equal(result.paneId, "pane");
		assert.equal(
			database.get<{ systemd_unit: string; pane_id: string }>(
				"SELECT systemd_unit, tab_id, pane_id FROM attempts WHERE id = ?",
				claim.attemptId,
			)?.pane_id,
			"pane",
		);
		assert.equal(calls[0]!.includes("not-in-command"), false);
		assert.equal(JSON.parse(readFileSync(join(attempt, "launch-intent.json"), "utf8")).paneIntent, undefined);
		assert.equal(calls[0]![0], "systemd-run");
		const promptIndex = calls[0]!.indexOf("--append-system-prompt");
		assert.notEqual(promptIndex, -1);
		assert.equal(calls[0]![promptIndex + 1], join(root, "worker.md"));
		assert.equal(calls[0]!.includes("--system-prompt"), false);
		assert.equal(
			database.get<{ kind: string }>("SELECT kind FROM artifacts WHERE attempt_id = ?", claim.attemptId)?.kind,
			"context-manifest",
		);
	} finally {
		database.close();
		rmSync(root, { recursive: true, force: true });
	}
});
