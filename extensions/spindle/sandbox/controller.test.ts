import assert from "node:assert/strict";
import { test } from "node:test";
import { SandboxController } from "./controller.ts";
import type { SandboxRuntime } from "./manager.ts";
import { policyEnvironment, resolveSandboxPolicy, type SandboxMode } from "./policy.ts";

const policyFor = (mode: SandboxMode) =>
	resolveSandboxPolicy(
		{ mode },
		policyEnvironment("/work/repo", { home: "/home/dev", platform: "linux", env: {}, tmp: "/tmp" }),
	);

/** A runtime double: records what it was asked to do, touches no OS sandbox. */
function fakeRuntime() {
	const calls = { initialized: 0, wrapped: [] as string[], resets: 0 };
	const runtime: SandboxRuntime = {
		initialize: async () => {
			calls.initialized += 1;
		},
		wrapWithSandbox: async (command) => {
			calls.wrapped.push(command);
			return `sandboxed ${command}`;
		},
		reset: async () => {
			calls.resets += 1;
		},
	};
	const start = async (policy: Parameters<SandboxRuntime["initialize"]>[0]): Promise<SandboxRuntime> => {
		await runtime.initialize(policy);
		return runtime;
	};
	return { calls, start };
}

test("a controller that enforces nothing lets every write through", async () => {
	const controller = new SandboxController(policyFor("off"));
	await controller.apply(policyFor("off"), "config");
	assert.equal(controller.enforcing, false);
	assert.equal(controller.allowsWrite("/home/dev/.zshrc"), true);
	assert.doesNotThrow(() => controller.writeGuard()("/home/dev/.zshrc"));
});

test("turning enforcement on mid-session changes the verdict of the same guard", async () => {
	const { start } = fakeRuntime();
	const controller = new SandboxController(policyFor("off"), "config", start);
	// The guard object is captured once, exactly as pi captures the tool's ops.
	const guard = controller.writeGuard();
	assert.doesNotThrow(() => guard("/home/dev/.zshrc"));

	await controller.apply(policyFor("workspace-write"), "request");
	assert.throws(() => guard("/home/dev/.zshrc"), /denied by mode 'workspace-write'/);
	assert.doesNotThrow(() => guard("/work/repo/src/a.ts"));

	// Reverting releases it again, without rebuilding anything.
	await controller.apply(policyFor("off"), "config");
	assert.doesNotThrow(() => guard("/home/dev/.zshrc"));
});

test("the read guard follows the live policy too", async () => {
	const { start } = fakeRuntime();
	const controller = new SandboxController(policyFor("off"), "config", start);
	// The guard object is captured once, exactly as the pi tool holds it.
	const guard = controller.readGuard();
	assert.doesNotThrow(() => guard("/home/dev/.ssh/id_ed25519"));

	await controller.apply(policyFor("workspace-write"), "request");
	assert.throws(() => guard("/home/dev/.ssh/id_ed25519"), /denied by mode 'workspace-write'/);
	assert.doesNotThrow(() => guard("/work/repo/src/a.ts"));

	// Reverting releases it again, without rebuilding anything.
	await controller.apply(policyFor("off"), "config");
	assert.doesNotThrow(() => guard("/home/dev/.ssh/id_ed25519"));
});

test("edit operations follow the live policy too", async () => {
	const { start } = fakeRuntime();
	const controller = new SandboxController(policyFor("workspace-write"), "request", start);
	await controller.apply(policyFor("workspace-write"), "request");
	const ops = controller.editOperations();
	await assert.rejects(() => ops.writeFile("/home/dev/.zshrc", "x"), /denied by mode/);
});

test("bash is routed through the runtime only while it is enforcing", async () => {
	const { calls, start } = fakeRuntime();
	const controller = new SandboxController(policyFor("off"), "config", start);
	const bash = controller.bashOperations();

	// Unsandboxed: pi's local backend runs it, so the runtime sees nothing.
	let output = "";
	const first = await bash.exec("echo plain", process.cwd(), {
		onData: (data) => {
			output += data.toString();
		},
	});
	assert.equal(first.exitCode, 0);
	assert.match(output, /plain/);
	assert.deepEqual(calls.wrapped, []);

	await controller.apply(policyFor("workspace-write"), "request");
	output = "";
	await bash.exec("echo wrapped", process.cwd(), {
		onData: (data) => {
			output += data.toString();
		},
	});
	assert.deepEqual(calls.wrapped, ["echo wrapped"]);
	assert.match(output, /sandboxed/);
});

test("applying a new enforcing policy resets the previous profile first", async () => {
	const { calls, start } = fakeRuntime();
	const controller = new SandboxController(policyFor("workspace-write"), "request", start);
	await controller.apply(policyFor("workspace-write"), "request");
	await controller.apply(policyFor("read-only"), "request");
	assert.equal(calls.initialized, 2);
	assert.equal(calls.resets, 1);
	await controller.dispose();
	assert.equal(calls.resets, 2);
});

test("a runtime's warnings (e.g. a resolved symlinked root) surface on the sandbox state event", async () => {
	const runtime: SandboxRuntime = {
		initialize: async () => {},
		wrapWithSandbox: async (command) => command,
		reset: async () => {},
		warnings: ["sandbox: root '/work/link' resolved through symlink '/work/link' to '/work/real'"],
	};
	const controller = new SandboxController(policyFor("off"), "config", async () => runtime);
	const state = await controller.apply(policyFor("workspace-write"), "request");
	assert.deepEqual(state.warnings, [
		"sandbox: root '/work/link' resolved through symlink '/work/link' to '/work/real'",
	]);
});

test("no warnings key is present on the sandbox state event when the runtime reports none", async () => {
	const { start } = fakeRuntime();
	const controller = new SandboxController(policyFor("off"), "config", start);
	const state = await controller.apply(policyFor("workspace-write"), "request");
	assert.equal("warnings" in state, false);
});

test("a runtime that fails to start leaves bash refusing to run, not running unsandboxed", async () => {
	const failing = async (): Promise<SandboxRuntime> => {
		throw new Error("sandbox: no macOS sandbox-exec on this host");
	};
	const controller = new SandboxController(policyFor("off"), "config", failing);
	const state = await controller.apply(policyFor("workspace-write"), "request");
	assert.equal(state.mode, "workspace-write");
	assert.equal(state.enforcing, true);
	assert.equal(state.osEnforced, false);
	assert.equal(state.source, "request");
	assert.equal(state.degradedReason, "sandbox: no macOS sandbox-exec on this host");
	assert.match(controller.describe(), /REFUSED/);
	assert.match(controller.describe(), /no macOS sandbox-exec on this host/);

	await assert.rejects(
		() => controller.bashOperations().exec("echo hi", process.cwd(), { onData: () => {} }),
		/no macOS sandbox-exec on this host/,
	);
	await assert.rejects(() => controller.wrapCommand("echo hi"), /no macOS sandbox-exec on this host/);

	// The write/edit/read path guards are unaffected: they never depended on the
	// OS runtime at all.
	assert.throws(() => controller.writeGuard()("/home/dev/.zshrc"), /denied by mode/);
	assert.throws(() => controller.readGuard()("/home/dev/.ssh/id_ed25519"), /denied by mode/);
});
