import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isOpenAIModel, usageProviderForModel } from "./protocol.ts";
import {
	acquireLease,
	LEASE_TTL_MS,
	loadToken,
	parseOpenAIUsage,
	readCache,
	readLease,
	releaseLease,
	usageCacheDir,
} from "./source.ts";

function agentDir(t: { after(fn: () => void): void }): string {
	const dir = mkdtempSync(join(tmpdir(), "usage-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

// A pid that no process on the test machine is using.
const DEAD_PID = 2 ** 22 + 4_321;

test("recognizes Codex subscription models", () => {
	assert.equal(isOpenAIModel({ provider: "openai-codex", id: "gpt-5-codex" }), true);
	assert.equal(isOpenAIModel({ provider: "openai", id: "gpt-5" }), false);
	assert.equal(usageProviderForModel({ provider: "openai-codex", id: "gpt-5-codex" }), "openai");
});

test("parses Codex usage windows by duration", () => {
	const snapshot = parseOpenAIUsage({
		rate_limit: {
			primary_window: { used_percent: 12.5, limit_window_seconds: 604800, reset_at: 1_800_000_000 },
			secondary_window: { used_percent: 4, limit_window_seconds: 18000, reset_at: 1_700_000_000 },
		},
	});
	assert.equal(snapshot.provider, "openai");
	assert.deepEqual(snapshot.windows, [
		{ label: "Week", usedPercent: 12.5, resetsAt: "2027-01-15T08:00:00.000Z" },
		{ label: "5h", usedPercent: 4, resetsAt: "2023-11-14T22:13:20.000Z" },
	]);
});

test("caches are scoped to the agent directory", (t) => {
	const dir = agentDir(t);
	assert.equal(usageCacheDir(dir), join(dir, "cache", "usage-status"));
	const cache = join(usageCacheDir(dir), "openai");
	acquireLease("openai", dir);
	writeFileSync(join(cache, "cache.json"), JSON.stringify({ fetchedAt: 1, snapshot: { windows: [] } }));
	assert.deepEqual(readCache("openai", dir), { fetchedAt: 1, snapshot: { windows: [] } });
	assert.equal(readCache("anthropic", dir), undefined);
});

test("only one live process holds a provider's poll lease", (t) => {
	const dir = agentDir(t);
	const now = 1_000_000;
	assert.equal(acquireLease("anthropic", dir, { now, pid: process.pid }), true);
	assert.equal(acquireLease("anthropic", dir, { now, pid: DEAD_PID }), false, "a live holder keeps its lease");
	assert.equal(acquireLease("openai", dir, { now, pid: DEAD_PID }), true, "leases are per provider");
	assert.equal(acquireLease("anthropic", dir, { now: now + 1_000, pid: process.pid }), true, "the holder renews");
	assert.equal(readLease("anthropic", dir)?.expiresAt, now + 1_000 + LEASE_TTL_MS);

	releaseLease("anthropic", dir, DEAD_PID);
	assert.equal(readLease("anthropic", dir)?.pid, process.pid, "only the holder releases");
	releaseLease("anthropic", dir);
	assert.equal(readLease("anthropic", dir), undefined);
});

test("a dead or expired holder's lease is taken over", (t) => {
	const dir = agentDir(t);
	const now = 1_000_000;
	assert.equal(acquireLease("openai", dir, { now, pid: DEAD_PID }), true);
	assert.equal(acquireLease("openai", dir, { now, pid: process.pid }), true, "a dead holder is replaced");
	assert.equal(readLease("openai", dir)?.pid, process.pid);

	const other = process.ppid;
	assert.equal(
		acquireLease("openai", dir, { now: now + LEASE_TTL_MS, pid: other }),
		true,
		"an expired lease is replaced",
	);
	assert.equal(readLease("openai", dir)?.pid, other);
});

test("tokens prefer pi's refreshed credentials, then the agent directory", async (t) => {
	const dir = agentDir(t);
	writeFileSync(
		join(dir, "auth.json"),
		JSON.stringify({ anthropic: { access: "sk-ant-oat-stored" }, "openai-codex": { access: "codex-stored" } }),
	);
	const requested: string[] = [];
	const modelRegistry = {
		getApiKeyForProvider: async (provider: string) => {
			requested.push(provider);
			return provider === "openai-codex" ? "codex-fresh" : "sk-ant-api-key";
		},
	};
	assert.equal(await loadToken("openai", { agentDir: dir, modelRegistry }), "codex-fresh");
	assert.equal(
		await loadToken("anthropic", { agentDir: dir, modelRegistry }),
		"sk-ant-oat-stored",
		"API keys cannot read subscription usage",
	);
	assert.deepEqual(requested, ["openai-codex", "anthropic"]);
	assert.equal(await loadToken("openai", { agentDir: dir }), "codex-stored");
});
