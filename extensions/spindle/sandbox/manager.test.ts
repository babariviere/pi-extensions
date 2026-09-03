import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";
import { initializeSandboxRuntime, sandboxAskCallback } from "./manager.ts";
import { type PolicyEnvironment, resolveSandboxPolicy, type SandboxPolicy } from "./policy.ts";

const execFileAsync = promisify(execFile);

const environment = (overrides: Partial<PolicyEnvironment> = {}): PolicyEnvironment => ({
	cwd: "/work/repo",
	home: "/home/dev",
	platform: "linux",
	env: {},
	tmp: "/tmp",
	...overrides,
});

test("an unrestricted policy gets a hook that approves any host", async () => {
	const ask = sandboxAskCallback(resolveSandboxPolicy({}, environment()));
	assert.ok(ask, "'*' cannot be expressed as an srt pattern, so it needs the hook");
	assert.equal(await ask({ host: "api.github.com", port: 443 }), true);
	assert.equal(await ask({ host: "anything.example", port: 443 }), true);
});

test("an allowlisted policy gets no hook, so srt denies what it does not name", () => {
	const policy = resolveSandboxPolicy({ network: { allowedDomains: ["github.com", "*.github.com"] } }, environment());
	assert.equal(sandboxAskCallback(policy), undefined);
});

/**
 * A real listen()+connect() round trip through the actual OS sandbox, not a
 * mock. This is the layer the unit tests above cannot reach: they exercise
 * `toSandboxRuntimeConfig`'s *shape*, not what `srt` actually does with it, and
 * that gap is exactly how the top-level-vs-`network`-nested `allowLocalBinding`
 * bug (see `policy.ts`) shipped with green tests. `srt` silently drops an
 * unknown key instead of rejecting it, so only running the wrapped command for
 * real proves the seatbelt/bubblewrap profile actually grants the socket ops.
 *
 * Skips itself (never fails the suite) when `@anthropic-ai/sandbox-runtime` is
 * not installed or the platform has no OS sandbox, mirroring
 * `initializeSandboxRuntime`'s own degrade path.
 */
const LOOPBACK_ROUNDTRIP_SCRIPT =
	'const net=require("net");' +
	"const s=net.createServer(c=>c.end());" +
	's.on("error",e=>{process.stdout.write("listen failed: "+e.message);process.exit(1)});' +
	's.listen(0,"127.0.0.1",()=>{const p=s.address().port;' +
	'const c=net.connect(p,"127.0.0.1",()=>{process.stdout.write("connected to 127.0.0.1:"+p);c.end();s.close()});' +
	'c.on("error",e=>{process.stdout.write("connect failed: "+e.message);process.exit(1)})})';

async function runWrapped(policy: SandboxPolicy): Promise<{ ok: boolean; stdout: string; degradedReason?: string }> {
	const { runtime, degradedReason } = await initializeSandboxRuntime(policy);
	if (!runtime) return { ok: false, stdout: "", degradedReason };
	try {
		const wrapped = await runtime.wrapWithSandbox(`node -e ${shellQuoteSingle(LOOPBACK_ROUNDTRIP_SCRIPT)}`);
		const { stdout } = await execFileAsync("/bin/sh", ["-c", wrapped], { timeout: 15_000 });
		return { ok: /^connected to 127\.0\.0\.1:\d+$/.test(stdout.trim()), stdout: stdout.trim() };
	} catch (error) {
		const stdout =
			error && typeof error === "object" && "stdout" in error ? String((error as { stdout: unknown }).stdout) : "";
		return { ok: false, stdout };
	} finally {
		await runtime.reset();
	}
}

const shellQuoteSingle = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

test("a loopback-enabled policy actually permits listen+connect under the real OS sandbox", async (t) => {
	const policy = resolveSandboxPolicy(
		{ mode: "workspace-write", network: { allowedDomains: ["*"], allowLoopback: true } },
		environment({ platform: process.platform, home: process.env.HOME ?? "/tmp", cwd: process.cwd() }),
	);
	const result = await runWrapped(policy);
	if (result.degradedReason) {
		t.skip(`no OS sandbox available here: ${result.degradedReason}`);
		return;
	}
	assert.equal(result.ok, true, `expected a successful loopback round trip, got: ${result.stdout}`);
});

test("a policy without allowLoopback denies the same round trip", async (t) => {
	const policy = resolveSandboxPolicy(
		{ mode: "workspace-write", network: { allowedDomains: ["*"] } },
		environment({ platform: process.platform, home: process.env.HOME ?? "/tmp", cwd: process.cwd() }),
	);
	const result = await runWrapped(policy);
	if (result.degradedReason) {
		t.skip(`no OS sandbox available here: ${result.degradedReason}`);
		return;
	}
	assert.equal(result.ok, false, `expected the round trip to be denied without allowLoopback, got: ${result.stdout}`);
});
