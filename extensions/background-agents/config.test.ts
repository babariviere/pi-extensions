import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	loadBackgroundAgentsConfig,
	normalizeBackgroundAgentsConfig,
	validateBackgroundAgentsConfig,
} from "./config.ts";

test("normalizes safe defaults and rollout overrides", () => {
	const config = normalizeBackgroundAgentsConfig({
		rollout: { defaultMode: "supervised", sourceOverrides: { slack: "observe" } },
		thresholds: { actionableMin: 80, noiseMax: 20 },
	});
	assert.equal(config.rollout.defaultMode, "supervised");
	assert.equal(config.rollout.sourceOverrides.slack, "observe");
	assert.deepEqual(config.thresholds, { actionableMin: 80, noiseMax: 20 });
});

test("rejects unsafe thresholds, socket permissions, and inline credentials", () => {
	assert.throws(
		() => normalizeBackgroundAgentsConfig({ thresholds: { actionableMin: 20, noiseMax: 20 } }),
		/noiseMax/,
	);
	assert.throws(() => normalizeBackgroundAgentsConfig({ socket: { mode: 0o666 } }), /world-accessible/);
	assert.throws(() => normalizeBackgroundAgentsConfig({ slack: { botToken: "not-a-reference" } }), /inline secret/);
});

test("loads a configuration relative to its file and validates repository and profile paths", () => {
	const root = mkdtempSync(join(tmpdir(), "background-agents-config-"));
	try {
		const repository = join(root, "repository");
		const agentDir = join(root, "agent");
		const authFile = join(agentDir, "auth.json");
		mkdirSync(join(repository, ".git"), { recursive: true });
		mkdirSync(agentDir);
		writeFileSync(authFile, "{}");
		const configPath = join(root, "background-agents.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				repositories: [{ id: "repo", root: "repository" }],
				profiles: [{ id: "claude", provider: "anthropic", agentDir: "agent", authFiles: ["agent/auth.json"] }],
			}),
		);
		const config = loadBackgroundAgentsConfig({ path: configPath });
		assert.equal(config.repositories[0]?.root, repository);
		assert.equal(config.repositories[0]?.gitDir, join(repository, ".git"));
		assert.equal(config.profiles[0]?.authFiles[0], authFile);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("fails closed when a configured repository or profile path is missing", () => {
	const config = normalizeBackgroundAgentsConfig({
		repositories: [{ id: "repo", root: "/missing/repository", gitDir: "/missing/repository/.git" }],
		profiles: [{ id: "profile", provider: "openai", agentDir: "/missing/agent", authFiles: [] }],
	});
	assert.throws(() => validateBackgroundAgentsConfig(config, { checkPaths: true }), /does not exist/);
});
