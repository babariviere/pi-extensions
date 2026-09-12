import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
	buildSystemdRunArgs,
	inspectTransientService,
	preflightLinuxHost,
	stopTransientService,
	waitForTransientService,
} from "./systemd.ts";

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
	assert.ok(args.includes("--property=ProtectHome=tmpfs"));
	assert.ok(args.includes("--property=BindPaths=/tmp/attempt"));
	assert.ok(args.includes("--property=BindPaths=/tmp/worktree"));
	assert.ok(args.includes("--property=BindReadOnlyPaths=/tmp/primary"));
	assert.ok(args.some((arg) => arg.startsWith("--property=UnsetEnvironment=") && arg.includes("GH_TOKEN")));
	assert.equal(
		args.some((arg) => arg === "--property=ReadOnlyPaths=/tmp/primary"),
		false,
	);
	assert.ok(args.includes("--property=NoNewPrivileges=yes"));
	assert.ok(args.includes("--property=BindPaths=/tmp/primary/.git"));
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

test("verifier mode fails closed for home, network, credentials, and shared Git metadata", () => {
	const args = buildSystemdRunArgs({
		unit: "background-verifier",
		workingDirectory: "/tmp/attempt/workspace",
		attemptDirectory: "/tmp/attempt",
		worktreeDirectory: "/tmp/attempt/workspace",
		primaryCheckout: "/tmp/primary",
		gitDirectory: "/tmp/primary/.git",
		profileDirectory: "/tmp/attempt/pi-profile",
		sessionDirectory: "/tmp/attempt/sessions",
		piArgs: [],
		limits: { maxRuntimeMs: 1000, memoryLimitBytes: 1024, cpuQuotaPercent: 50, processLimit: 10 },
		security: "verifier",
		inaccessiblePaths: ["/home/operator/.pi/agent/auth.json", "/home/operator/.pi/agent/background-agents.sock"],
	});
	assert.ok(args.includes("--property=ProtectHome=tmpfs"));
	assert.ok(args.includes("--property=PrivateNetwork=yes"));
	assert.ok(args.some((arg) => arg.startsWith("--property=UnsetEnvironment=") && arg.includes("GITHUB_TOKEN")));
	assert.ok(args.includes("--property=BindReadOnlyPaths=/tmp/primary/.git"));
	assert.equal(
		args.some((arg) => arg === "--property=ReadWritePaths=/tmp/primary/.git"),
		false,
	);
	assert.ok(args.includes("--property=InaccessiblePaths=/home/operator/.pi/agent/auth.json"));
});

test("worker services clear arbitrary inherited environment and hide the primary Git metadata", () => {
	const args = buildSystemdRunArgs({
		unit: "background-worker",
		workingDirectory: "/tmp/attempt/worktree",
		attemptDirectory: "/tmp/attempt",
		worktreeDirectory: "/tmp/attempt/worktree",
		primaryCheckout: "/tmp/primary",
		gitDirectory: "/tmp/attempt/git/.git",
		profileDirectory: "/tmp/attempt/pi-profile",
		sessionDirectory: "/tmp/attempt/sessions",
		piArgs: [],
		limits: { maxRuntimeMs: 1000, memoryLimitBytes: 1024, cpuQuotaPercent: 50, processLimit: 10 },
		inaccessiblePaths: ["/tmp/primary", "/tmp/primary/.git"],
		writableGit: true,
		exposePrimaryCheckout: false,
	});
	const envIndex = args.indexOf("/usr/bin/env");
	assert.ok(envIndex >= 0);
	assert.deepEqual(args.slice(envIndex, envIndex + 6), [
		"/usr/bin/env",
		"-i",
		"HOME=/tmp/attempt/pi-profile",
		"PATH=/usr/local/bin:/usr/bin:/bin",
		"TMPDIR=/tmp/attempt",
		"PI_CODING_AGENT_DIR=/tmp/attempt/pi-profile",
	]);
	assert.equal(
		args.some((arg) => arg === "--setenv=SECRET_FROM_CONTROLLER=leaked"),
		false,
	);
	assert.equal(args.includes("--property=BindReadOnlyPaths=/tmp/primary"), false);
	assert.ok(args.includes("--property=InaccessiblePaths=/tmp/primary"));
});

test("exposes only the staged prompt as an additional read-only path", () => {
	const args = buildSystemdRunArgs({
		unit: "background-agent",
		workingDirectory: "/srv/worktree",
		attemptDirectory: "/srv/attempt",
		worktreeDirectory: "/srv/worktree",
		primaryCheckout: "/srv/repo",
		gitDirectory: "/srv/repo/.git",
		profileDirectory: "/srv/attempt/pi-profile",
		sessionDirectory: "/srv/attempt/sessions",
		piArgs: [],
		limits: { maxRuntimeMs: 1000, memoryLimitBytes: 1024, cpuQuotaPercent: 50, processLimit: 10 },
		readOnlyPaths: ["/opt/pi/roles/worker.md"],
	});
	assert.ok(args.includes("--property=BindReadOnlyPaths=/opt/pi/roles/worker.md"));
	assert.equal(args.filter((arg) => arg.startsWith("--property=BindPaths=")).length, 3);
	assert.equal(
		args.some((arg) => arg.includes("ProtectHome=read-only")),
		false,
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

test("confirms a nonexistent systemd unit is absent rather than unknown", async () => {
	const inspector = {
		run: async () => ({ ok: true, stdout: "LoadState=not-found\nActiveState=inactive\n" }),
	};
	assert.equal(await inspectTransientService("background-missing", inspector), "not-found");
	let calls = 0;
	await stopTransientService("background-missing", {
		run: async (_command, args) => {
			calls += 1;
			return args[1] === "stop"
				? { ok: false, error: "unit not loaded" }
				: { ok: true, stdout: "LoadState=not-found\n" };
		},
	});
	assert.equal(calls, 2);
});
