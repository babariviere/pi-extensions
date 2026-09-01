/**
 * The capability probe: classification and report shape.
 *
 * No probe is actually executed here (the suite must not depend on the network,
 * on `gh`, or on a sandbox being installed); the injected `exec` stands in for
 * the sandboxed shell, which is exactly the seam the bridge uses in production.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	formatPreflightReport,
	nightPreflightProbes,
	preflightPathFor,
	type ProbeOutcome,
	runPreflight,
	shellQuote,
	writePreflightReport,
} from "./preflight.ts";

test("the probe list covers the six answers a night run plans with", () => {
	const ids = nightPreflightProbes({ workspacePath: "/night/clone" }).map((probe) => probe.id);
	assert.deepEqual(ids, ["https-egress", "raw-dns", "ssh-github", "gh-auth", "loopback-tcp", "jj-workspace"]);
});

test("the jj probe is skipped when the run has no working copy", () => {
	const ids = nightPreflightProbes().map((probe) => probe.id);
	assert.equal(ids.includes("jj-workspace"), false);
});

test("the jj probe quotes a working copy whose path has spaces", () => {
	const probe = nightPreflightProbes({ workspacePath: "/night/2026-09-01 1822" }).find(
		(entry) => entry.id === "jj-workspace",
	);
	assert.equal(probe?.command.includes("'/night/2026-09-01 1822'"), true);
});

test("shellQuote survives a quote in the path", () => {
	assert.equal(shellQuote("/a/b'c"), "'/a/b'\\''c'");
});

const outcomes = (byId: Record<string, ProbeOutcome>) => async (probe: { id: string }) =>
	byId[probe.id] ?? { exitCode: 1, output: "not stubbed" };

test("a curl that returns 000 is a failure even though curl exits 0", async () => {
	const [https] = await runPreflight(
		nightPreflightProbes().filter((probe) => probe.id === "https-egress"),
		outcomes({ "https-egress": { exitCode: 0, output: "000" } }),
	);
	assert.equal(https.ok, false);
	assert.equal(https.detail, "000");
});

test("a curl that returns 200 is a success", async () => {
	const [https] = await runPreflight(
		nightPreflightProbes().filter((probe) => probe.id === "https-egress"),
		outcomes({ "https-egress": { exitCode: 0, output: "200" } }),
	);
	assert.equal(https.ok, true);
});

test("github's ssh greeting counts as success despite exit 1", async () => {
	const [ssh] = await runPreflight(
		nightPreflightProbes().filter((probe) => probe.id === "ssh-github"),
		outcomes({
			"ssh-github": { exitCode: 1, output: "Hi babariviere! You've successfully authenticated, but GitHub does not provide shell access." },
		}),
	);
	assert.equal(ssh.ok, true);
});

test("a hostname that does not resolve is a failed ssh probe", async () => {
	const [ssh] = await runPreflight(
		nightPreflightProbes().filter((probe) => probe.id === "ssh-github"),
		outcomes({ "ssh-github": { exitCode: 255, output: "ssh: Could not resolve hostname github.com: -65563" } }),
	);
	assert.equal(ssh.ok, false);
	assert.match(ssh.detail, /Could not resolve hostname/);
});

test("a probe whose exec throws is recorded as failed, not propagated", async () => {
	const results = await runPreflight(nightPreflightProbes().slice(0, 1), async () => {
		throw new Error("timeout:20");
	});
	assert.equal(results[0].ok, false);
	assert.match(results[0].detail, /timeout:20/);
});

test("the report states the answer and what it rules out", async () => {
	const results = await runPreflight(
		nightPreflightProbes({ workspacePath: "/night/clone" }),
		outcomes({
			"https-egress": { exitCode: 0, output: "200" },
			"raw-dns": { exitCode: 1, output: "connection timed out; no servers could be reached" },
			"ssh-github": { exitCode: 255, output: "ssh: Could not resolve hostname github.com: -65563" },
			"gh-auth": { exitCode: 0, output: "Logged in to github.com account babariviere (keyring)" },
			"loopback-tcp": { exitCode: 1, output: "connect failed: connect EPERM 127.0.0.1:54123" },
			"jj-workspace": { exitCode: 0, output: "Working copy changes:" },
		}),
	);
	const report = formatPreflightReport(results, {
		startedAt: new Date(2026, 8, 1, 18, 22),
		workspacePath: "/night/clone",
	});
	assert.match(report, /\| HTTPS egress \(api\.github\.com\) \| yes \|/);
	assert.match(report, /\| SSH to github\.com \| NO \|/);
	assert.match(report, /\| loopback TCP \| NO \|/);
	assert.match(report, /\*\*loopback TCP\*\*: unavailable - no loopback means no local database/);
	assert.match(report, /Working copy: `\/night\/clone`/);
});

test("the report goes beside the per-subagent workspaces, so every child can read it", () => {
	assert.equal(
		preflightPathFor({ workspacePath: "/night/sandboxes/repo/run", reportPath: "/vault/report.md" }),
		"/night/sandboxes/repo/run.agents/sandbox-capabilities.md",
	);
	assert.equal(preflightPathFor({ reportPath: "/vault/report.md" }), "/vault/sandbox-capabilities.md");
});

test("writing the report creates its directory", () => {
	const dir = mkdtempSync(join(tmpdir(), "preflight-"));
	try {
		const path = join(dir, "nested", "sandbox-capabilities.md");
		assert.equal(writePreflightReport(path, "# probe\n"), true);
		assert.equal(readFileSync(path, "utf-8"), "# probe\n");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
