import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { buildReplayEnvironment, spawnReplayRunner, replayEvidence } from "./reproduce.ts";
import { createEvidenceManifest, MAX_OUTPUT_BYTES, sha256, withEvidenceSection } from "./evidence.ts";
import { spawnCommandRunner } from "../git/repository.ts";
import { BackgroundAgentsDatabase } from "../database.ts";

async function git(repository: string, args: string[]): Promise<string> {
	const result = await spawnCommandRunner("git", ["-C", repository, ...args]);
	if (result.code !== 0) throw new Error(result.stderr || result.stdout);
	return result.stdout.trim();
}

async function repository(): Promise<{ path: string; base: string; candidate: string }> {
	const path = mkdtempSync(join(tmpdir(), "background-evidence-"));
	await git(path, ["init", "-b", "main"]);
	await git(path, ["config", "user.email", "evidence@example.test"]);
	await git(path, ["config", "user.name", "Evidence Test"]);
	writeFileSync(join(path, "marker"), "base\n");
	await git(path, ["add", "marker"]);
	await git(path, ["commit", "-m", "base"]);
	const base = await git(path, ["rev-parse", "HEAD"]);
	writeFileSync(join(path, "marker"), "candidate\n");
	await git(path, ["add", "marker"]);
	await git(path, ["commit", "-m", "candidate"]);
	const candidate = await git(path, ["rev-parse", "HEAD"]);
	return { path, base, candidate };
}

test("replays base failure and candidate acceptance at exact commits without a shell", async () => {
	const paths = await repository();
	try {
		const manifest = createEvidenceManifest({
			baseSha: paths.base,
			candidateSha: paths.candidate,
			bugReproduction: true,
			commands: [
				{
					executable: process.execPath,
					argv: ["-e", "process.exit(1)"],
					cwd: ".",
					timeoutMs: 5_000,
					phase: "base",
					purpose: "reproduction",
					expectedExitCode: 1,
				},
				{
					executable: process.execPath,
					argv: ["-e", "process.exit(0)"],
					cwd: ".",
					timeoutMs: 5_000,
					phase: "candidate",
					purpose: "reproduction",
				},
				{
					executable: process.execPath,
					argv: ["-e", "process.exit(0)"],
					cwd: ".",
					timeoutMs: 5_000,
					phase: "candidate",
					purpose: "acceptance",
				},
			],
		});
		const replay = await replayEvidence({ repository: paths.path, manifest, runner: spawnReplayRunner });
		assert.equal(replay.passed, true);
		assert.deepEqual(
			replay.commands.map((item) => item.actual.exitCode),
			[1, 0, 0],
		);
		assert.equal(
			replay.commands.every((item) => item.worktree !== paths.path),
			true,
		);
	} finally {
		rmSync(paths.path, { recursive: true, force: true });
	}
});

test("persists manifests, actual results, verdicts, and replay history", () => {
	const directory = mkdtempSync(join(tmpdir(), "background-evidence-db-"));
	try {
		const database = new BackgroundAgentsDatabase(join(directory, "controller.sqlite"));
		const caseId = database.createCase({ title: "Evidence", source: "manual" });
		const sha = "b".repeat(40);
		const manifest = createEvidenceManifest({
			baseSha: sha,
			candidateSha: sha,
			toolVersions: { node: process.version },
			commands: [
				{
					executable: process.execPath,
					argv: [],
					cwd: ".",
					timeoutMs: 100,
					phase: "candidate",
					purpose: "acceptance",
				},
			],
		});
		const manifestId = database.createEvidenceManifest({ caseId, manifest });
		assert.deepEqual(database.getEvidenceManifest(manifestId), manifest);
		const first = database.createVerificationRun({
			manifestId,
			report: {
				verdict: "pass",
				confidence: { score: 95, rationale: "replayed", uncertainties: [] },
				ciChecks: {},
				rationale: "replayed",
				uncertainties: [],
				replay: { commands: [{ actual: { exitCode: 0 } }] },
			},
		});
		const second = database.createVerificationRun({
			manifestId,
			replayOf: first,
			report: {
				verdict: "needs-human",
				confidence: { score: 40, rationale: "missing CI", uncertainties: ["CI"] },
				ciChecks: { required: "missing" },
				rationale: "missing CI",
				uncertainties: ["CI"],
				replay: { commands: [{ actual: { exitCode: 0 } }] },
			},
		});
		assert.deepEqual(
			database.listVerificationRuns(manifestId).map((run) => run.id),
			[first, second],
		);
		database.close();
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("requires candidate acceptance and renders a concise PR section", () => {
	const sha = "a".repeat(40);
	assert.throws(
		() =>
			createEvidenceManifest({
				baseSha: sha,
				candidateSha: sha,
				commands: [
					{ executable: "node", argv: [], cwd: ".", timeoutMs: 100, phase: "candidate", purpose: "reproduction" },
				],
			}),
		/candidate acceptance/,
	);
	const manifest = createEvidenceManifest({
		baseSha: sha,
		candidateSha: sha,
		commands: [{ executable: "node", argv: [], cwd: ".", timeoutMs: 100, phase: "candidate", purpose: "acceptance" }],
	});
	assert.match(withEvidenceSection("Summary", manifest), /Base: `a{40}`/);
});

test("rejects credential-like and unapproved environment requests", () => {
	const sha = "a".repeat(40);
	const command = (environment: string[]) => ({
		executable: process.execPath,
		argv: [],
		cwd: ".",
		timeoutMs: 100,
		phase: "candidate" as const,
		purpose: "acceptance" as const,
		environment,
	});
	assert.throws(
		() => createEvidenceManifest({ baseSha: sha, candidateSha: sha, commands: [command(["GITHUB_TOKEN"])] }),
		/credential-like/,
	);
	assert.throws(
		() => createEvidenceManifest({ baseSha: sha, candidateSha: sha, commands: [command(["WORKER_SETTING"])] }),
		/not allowed/,
	);
	assert.deepEqual(
		buildReplayEnvironment({ PATH: "/configured/tools", GITHUB_TOKEN: "secret", HOME: "/safe" }, [
			"PATH",
			"HOME",
			"GITHUB_TOKEN",
		]),
		{ PATH: "/configured/tools", HOME: "/safe" },
	);
});

test("bounds captured output while recording the full-stream hash", async () => {
	const paths = await repository();
	try {
		const output = "x".repeat(MAX_OUTPUT_BYTES * 3);
		const manifest = createEvidenceManifest({
			baseSha: paths.base,
			candidateSha: paths.candidate,
			commands: [
				{
					executable: process.execPath,
					argv: ["-e", `process.stdout.write(${JSON.stringify(output)})`],
					cwd: ".",
					timeoutMs: 5_000,
					phase: "candidate",
					purpose: "acceptance",
				},
			],
		});
		const replay = await replayEvidence({ repository: paths.path, manifest });
		const actual = replay.commands[0].actual;
		assert.equal(replay.passed, true);
		assert.equal(actual.stdout.length, MAX_OUTPUT_BYTES);
		assert.equal(actual.stdoutBytes, output.length);
		assert.equal(actual.stdoutTruncated, true);
		assert.equal(actual.outputHash, sha256(output));
		assert.equal(actual.outputBytes, output.length);
		assert.equal(actual.outputTruncated, true);
	} finally {
		rmSync(paths.path, { recursive: true, force: true });
	}
});

test("timeout cleanup terminates descendants, not just the command child", async () => {
	const paths = await repository();
	const marker = join(paths.path, "descendant-survived");
	try {
		const descendant = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "survived"), 500)`;
		const manifest = createEvidenceManifest({
			baseSha: paths.base,
			candidateSha: paths.candidate,
			commands: [
				{
					executable: process.execPath,
					argv: [
						"-e",
						`const { spawn } = require("node:child_process"); spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "ignore" }); setTimeout(() => {}, 60000);`,
					],
					cwd: ".",
					timeoutMs: 100,
					phase: "candidate",
					purpose: "acceptance",
				},
			],
		});
		const replay = await replayEvidence({ repository: paths.path, manifest });
		assert.equal(replay.passed, false);
		assert.equal(replay.commands[0].actual.timedOut, true);
		await new Promise((resolve) => setTimeout(resolve, 700));
		assert.equal(existsSync(marker), false);
	} finally {
		rmSync(paths.path, { recursive: true, force: true });
	}
});
