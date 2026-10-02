import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readActiveNightRun, type ActiveNightRun } from "../night-mode/night-run.ts";
import { activeNightSandboxRequest } from "../sandbox/night-bridge.ts";
import { activeNightMcpReadOnly } from "../sandbox/night-mcp.ts";

test("an isolated durable worker keeps the admitted night policy when the global handshake changes", async () => {
	const directory = await mkdtemp(join(tmpdir(), "durable-night-policy-"));
	const keys = ["PI_CODING_AGENT_DIR", "PI_CODE_MODE_SUBAGENT", "PI_DURABLE_NIGHT_RUN_FILE", "PI_NIGHT_RUN"];
	const old = keys.map((key) => process.env[key]);
	const snapshot: ActiveNightRun = {
		startedAt: 1,
		reportPath: join(directory, "report.md"),
		maxPullRequests: 1,
		sandbox: { mode: "read-only", allowWrite: [join(directory, "artifacts")], denyRead: ["/private"] },
		mcp: { readOnly: true },
		ledgerDir: join(directory, "ledger"),
		configHome: join(directory, "config-home"),
	};
	try {
		process.env.PI_CODING_AGENT_DIR = directory;
		process.env.PI_DURABLE_NIGHT_RUN_FILE = join(directory, "approved.json");
		await writeFile(process.env.PI_DURABLE_NIGHT_RUN_FILE, JSON.stringify(snapshot), { mode: 0o600 });
		await mkdir(join(directory, "night"));
		await writeFile(
			join(directory, "night", "active.json"),
			JSON.stringify({ ...snapshot, startedAt: 2, sandbox: { mode: "off" }, mcp: { readOnly: false } }),
		);
		delete process.env.PI_CODE_MODE_SUBAGENT;
		delete process.env.PI_NIGHT_RUN;
		assert.equal(readActiveNightRun()?.startedAt, 2, "bystanders never consume worker snapshot policy");
		process.env.PI_CODE_MODE_SUBAGENT = "1";
		process.env.PI_NIGHT_RUN = "1";
		assert.deepEqual(readActiveNightRun(), snapshot);
		assert.deepEqual(activeNightSandboxRequest(), snapshot.sandbox);
		assert.equal(activeNightMcpReadOnly(), true);
		await rm(join(directory, "night", "active.json"));
		assert.deepEqual(readActiveNightRun(), snapshot, "clearing global state cannot silently loosen recovered work");
	} finally {
		for (const [index, key] of keys.entries()) {
			if (old[index] === undefined) delete process.env[key];
			else process.env[key] = old[index];
		}
		await rm(directory, { recursive: true, force: true });
	}
});
