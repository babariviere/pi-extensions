import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { buildSystemdRunArgs, preflightLinuxHost, waitForTransientService } from "./systemd.ts";

test("builds strict transient-service argv with only approved write paths", () => {
	const args = buildSystemdRunArgs({
		unit: "background-a",
		workingDirectory: "/tmp/worktree",
		attemptDirectory: "/tmp/attempt",
		worktreeDirectory: "/tmp/worktree",
		primaryCheckout: "/tmp/primary",
		gitDirectory: "/tmp/primary/.git",
		profileDirectory: "/tmp/attempt/pi-profile",
		sessionDirectory: "/tmp/attempt/sessions",
		piArgs: ["--model", "openai/model", "--", "hello; echo bad"],
		limits: { maxRuntimeMs: 1000, memoryLimitBytes: 1024, cpuQuotaPercent: 50, processLimit: 10 },
	});
	assert.ok(args.includes("--property=ProtectSystem=strict"));
	assert.ok(args.includes("--property=PrivateUsers=yes"));
	assert.ok(args.includes("--property=ProtectHome=read-only"));
	assert.ok(args.includes("--property=NoNewPrivileges=yes"));
	assert.ok(args.includes("--property=ReadWritePaths=/tmp/primary/.git"));
	assert.ok(args.includes("--setenv=TMPDIR=/tmp/attempt"));
	assert.ok(args.includes("--setenv=PI_BACKGROUND_AGENT_ATTEMPT=1"));
	assert.equal(
		args.some((arg) => arg.includes("hello; echo bad")),
		true,
	);
	assert.throws(
		() =>
			buildSystemdRunArgs({
				unit: "bad",
				workingDirectory: "/tmp/primary",
				attemptDirectory: "/tmp/attempt",
				worktreeDirectory: "/tmp/primary",
				primaryCheckout: "/tmp/primary",
				gitDirectory: "/tmp/primary/.git",
				profileDirectory: "/tmp/attempt/pi-profile",
				sessionDirectory: "/tmp/attempt/sessions",
				piArgs: [],
				limits: { maxRuntimeMs: 1000, memoryLimitBytes: 1024, cpuQuotaPercent: 1, processLimit: 1 },
			}),
		/inside the primary/,
	);
});

test("fails closed on portable non-Linux hosts and checks injected Linux dependencies", async () => {
	assert.deepEqual(await preflightLinuxHost({ platform: "darwin" }), {
		ok: false,
		errors: ["background attempts require a Linux systemd host"],
	});
	const root = mkdtempSync(join(tmpdir(), "background-runtime-preflight-"));
	try {
		const controllers = join(root, "cgroup.controllers");
		writeFileSync(controllers, "cpu memory pids");
		const calls: string[][] = [];
		const result = await preflightLinuxHost({
			platform: "linux",
			cgroupControllersPath: controllers,
			runner: {
				run: async (command, args) => {
					calls.push([command, ...args]);
					return { ok: true, stdout: command === "systemd-run" ? "systemd 250" : "ok" };
				},
			},
		});
		assert.equal(result.ok, true);
		assert.ok(calls.some((call) => call.join(" ") === "gh stack --help"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("waits for a transient unit to report a successful terminal state", async () => {
	const states = [
		"ActiveState=active\nResult=running\nExecMainStatus=0\n",
		"ActiveState=inactive\nResult=success\nExecMainStatus=0\n",
	];
	const result = await waitForTransientService("background-a", {
		timeoutMs: 1000,
		pollMs: 1,
		inspector: { run: async () => ({ ok: true, stdout: states.shift() ?? states[0] }) },
	});
	assert.deepEqual(result, { state: "succeeded", exitCode: 0 });
});
