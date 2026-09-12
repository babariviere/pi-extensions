import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
	assert.deepEqual(config.question, { maxRuntimeMs: 60_000, maxAttempts: 1, maxResults: 10 });
	assert.deepEqual(config.classifier, {
		modelVersion: "controller-default",
		exampleLimit: 12,
		relatedCaseLimit: 8,
		maxAttempts: 3,
		retryBackoffMs: 30_000,
	});
	const repository = normalizeBackgroundAgentsConfig({ repositories: [{ id: "repo", root: "/tmp/repo" }] })
		.repositories[0];
	assert.equal(repository?.remote, "origin");
	assert.equal(repository?.defaultBaseBranch, "main");
});

test("validates bounded classifier retry settings", () => {
	assert.equal(
		normalizeBackgroundAgentsConfig({ classifier: { maxAttempts: 2, retryBackoffMs: 250 } }).classifier.maxAttempts,
		2,
	);
	assert.equal(
		normalizeBackgroundAgentsConfig({ classifier: { maxAttempts: 2, retryBackoffMs: 250 } }).classifier
			.retryBackoffMs,
		250,
	);
	assert.throws(() => normalizeBackgroundAgentsConfig({ classifier: { maxAttempts: 0 } }), /classifier.maxAttempts/);
	assert.throws(
		() => normalizeBackgroundAgentsConfig({ classifier: { retryBackoffMs: -1 } }),
		/classifier.retryBackoffMs/,
	);
});

test("validates repository delivery settings", () => {
	assert.throws(
		() => normalizeBackgroundAgentsConfig({ repositories: [{ id: "repo", root: "/tmp/repo", remote: " " }] }),
		/repositories\[0\]\.remote/,
	);
	assert.throws(
		() =>
			normalizeBackgroundAgentsConfig({ repositories: [{ id: "repo", root: "/tmp/repo", defaultBaseBranch: " " }] }),
		/defaultBaseBranch/,
	);
});

test("does not expose a configurable Linear query", () => {
	const config = normalizeBackgroundAgentsConfig({
		sources: { linear: { query: "query Bypass { issues { nodes { id } } }" } },
	});
	assert.equal("query" in config.sources.linear, false);
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
		chmodSync(agentDir, 0o700);
		chmodSync(authFile, 0o600);
		chmodSync(agentDir, 0o700);
		chmodSync(authFile, 0o600);
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

test("rejects permissive source credential files", () => {
	const root = mkdtempSync(join(tmpdir(), "background-agents-credentials-"));
	try {
		const credentialPath = join(root, "slack.json");
		writeFileSync(credentialPath, '{"token":"secret"}');
		chmodSync(credentialPath, 0o640);
		const ownerUid = lstatSync(credentialPath).uid;
		const config = normalizeBackgroundAgentsConfig({
			socket: { ownerUid },
			sources: { slack: { enabled: true, credentialPath } },
		});
		assert.throws(() => validateBackgroundAgentsConfig(config, { checkPaths: true }), /group- or world-accessible/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("rejects a source credential with the wrong owner", () => {
	const root = mkdtempSync(join(tmpdir(), "background-agents-credentials-"));
	try {
		const credentialPath = join(root, "linear.json");
		writeFileSync(credentialPath, '{"token":"secret"}');
		chmodSync(credentialPath, 0o600);
		const stats = lstatSync(credentialPath);
		const config = normalizeBackgroundAgentsConfig({
			socket: { ownerUid: stats.uid },
			sources: { linear: { enabled: true, credentialPath } },
		});
		assert.throws(
			() =>
				validateBackgroundAgentsConfig(config, {
					checkPaths: true,
					credentialStat: () => ({
						uid: stats.uid + 1,
						mode: stats.mode,
						isFile: () => true,
						isSymbolicLink: () => false,
					}),
				}),
			/owned by the controller user/,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("rejects symlinked source credentials", () => {
	const root = mkdtempSync(join(tmpdir(), "background-agents-credentials-"));
	try {
		const targetPath = join(root, "datadog.json");
		const credentialPath = join(root, "datadog-link.json");
		writeFileSync(targetPath, '{"apiKey":"secret","appKey":"secret"}');
		chmodSync(targetPath, 0o600);
		symlinkSync(targetPath, credentialPath);
		const ownerUid = lstatSync(credentialPath).uid;
		const config = normalizeBackgroundAgentsConfig({
			socket: { ownerUid },
			sources: { datadog: { enabled: true, credentialPath } },
		});
		assert.throws(() => validateBackgroundAgentsConfig(config, { checkPaths: true }), /must not be a symlink/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("rejects directories as source credentials", () => {
	const root = mkdtempSync(join(tmpdir(), "background-agents-credentials-"));
	try {
		const credentialPath = join(root, "slack-credentials");
		mkdirSync(credentialPath);
		const ownerUid = lstatSync(credentialPath).uid;
		const config = normalizeBackgroundAgentsConfig({
			socket: { ownerUid },
			sources: { slack: { enabled: true, credentialPath } },
		});
		assert.throws(() => validateBackgroundAgentsConfig(config, { checkPaths: true }), /must be a regular file/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("accepts 0600 credentials for enabled external sources", () => {
	const root = mkdtempSync(join(tmpdir(), "background-agents-credentials-"));
	try {
		const credentialPath = join(root, "credentials.json");
		writeFileSync(credentialPath, '{"token":"secret"}');
		chmodSync(credentialPath, 0o600);
		const ownerUid = lstatSync(credentialPath).uid;
		const config = normalizeBackgroundAgentsConfig({
			socket: { ownerUid },
			sources: {
				slack: { enabled: true, credentialPath },
				linear: { enabled: true, credentialPath },
				datadog: { enabled: true, credentialPath },
			},
		});
		assert.doesNotThrow(() => validateBackgroundAgentsConfig(config, { checkPaths: true }));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("can disable path checks for pure normalization tests", () => {
	const config = normalizeBackgroundAgentsConfig({
		sources: { slack: { enabled: true, credentialPath: "/missing/slack.json" } },
	});
	assert.doesNotThrow(() => validateBackgroundAgentsConfig(config, { checkPaths: false }));
});
