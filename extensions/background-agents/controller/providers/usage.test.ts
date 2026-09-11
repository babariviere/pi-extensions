import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, test } from "node:test";
import { normalizeBackgroundAgentsConfig } from "../../config.ts";
import { BackgroundAgentsDatabase } from "../database.ts";
import { ProfileUsageController } from "./usage.ts";

const directories: string[] = [];

function setup() {
	const directory = mkdtempSync(join(tmpdir(), "background-agents-usage-"));
	directories.push(directory);
	const database = new BackgroundAgentsDatabase(join(directory, "controller.sqlite"));
	const config = normalizeBackgroundAgentsConfig({
		profiles: [
			{ id: "claude-work", provider: "anthropic", agentDir: directory, allowedModels: ["claude"] },
			{ id: "openai-work", provider: "openai", agentDir: directory, allowedModels: ["codex"] },
		],
	});
	return { database, config };
}

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("profile usage control", () => {
	test("collects and persists isolated profile usage, including both subscription providers", async () => {
		const { database, config } = setup();
		const calls: string[] = [];
		const usage = new ProfileUsageController(database, config.profiles, {
			clock: () => new Date("2026-01-01T00:00:00Z"),
			collector: async (profile) => {
				calls.push(profile.id);
				return {
					profileId: profile.id,
					provider: profile.provider,
					observedAt: "2026-01-01T00:00:00Z",
					windows: [{ label: "Week", usedPercent: profile.provider === "anthropic" ? 20 : 30 }],
				};
			},
		});
		await usage.refresh();
		assert.deepEqual(calls, ["claude-work", "openai-work"]);
		assert.equal(database.latestUsageSnapshots("claude-work").length, 1);
		assert.equal(database.latestUsageSnapshots("openai-work").length, 1);
		assert.equal(usage.canSchedule(config.profiles[0]!, "worker"), true);
		database.close();
	});

	test("allows cheap classification without usage but blocks stale expensive work", async () => {
		const { database, config } = setup();
		const now = new Date("2026-01-01T00:00:00Z");
		const usage = new ProfileUsageController(database, config.profiles, {
			clock: () => now,
			collector: async (profile) => ({
				profileId: profile.id,
				provider: profile.provider,
				observedAt: now,
				windows: [{ label: "5h", usedPercent: 40 }],
			}),
		});
		assert.equal(usage.canSchedule(config.profiles[0]!, "classifier"), true);
		assert.equal(usage.canSchedule(config.profiles[0]!, "worker"), false);
		await usage.refresh();
		assert.equal(usage.canSchedule(config.profiles[0]!, "worker"), true);
		assert.equal(usage.canSchedule(config.profiles[0]!, "worker", new Date("2026-01-01T00:20:00Z")), false);
		database.close();
	});

	test("does not consume the configured interactive reserve", async () => {
		const { database, config } = setup();
		const profile = { ...config.profiles[0]!, interactiveReserve: 2 };
		const usage = new ProfileUsageController(database, [profile], {
			collector: async () => ({
				provider: "anthropic" as const,
				windows: [{ label: "Week", usedPercent: 10 }],
				remaining: 2,
			}),
		});
		await usage.refresh();
		assert.equal(usage.canSchedule(profile, "worker"), false);
		database.close();
	});
});
