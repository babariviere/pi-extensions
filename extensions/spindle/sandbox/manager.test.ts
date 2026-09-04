import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import dns from "node:dns/promises";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { initializeSandboxRuntime, lateBoundBashOperations } from "./manager.ts";
import type { SandboxRuntime } from "./manager.ts";
import { DEFAULT_DENY_WRITE, type SandboxPolicy } from "./policy.ts";
import { SeatbeltSandbox } from "./seatbelt.ts";
import { supervisedSpawn } from "./supervised-spawn.ts";

/**
 * The real sandbox-exec round trip below self-skips when this host cannot run
 * it. It is the load-bearing suite in this file: shape assertions alone
 * shipped a broken profile with green tests once already (allowLocalBinding,
 * 2026-09-01). Check the test reporter's own skip count, not just its pass
 * count, when validating this.
 *
 * The skip condition is a real smoke test, not just a platform/binary check:
 * a process that is itself already confined by a Seatbelt profile (for
 * example, this suite running inside a sandboxed `pi.bash` shell of its own)
 * cannot call `sandbox_apply` a second time — the kernel refuses with
 * "Operation not permitted" regardless of how correct the generated profile
 * is. Detecting that dynamically, rather than assuming any darwin host with
 * `/usr/bin/sandbox-exec` can nest a sandbox, is what keeps this from
 * reporting a false failure (or worse, a silently-broken profile masquerading
 * as one) when the suite itself happens to be run from inside another
 * sandbox.
 */
function canRunNestedSandbox(): boolean {
	if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) return false;
	try {
		execFileSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "--", "/bin/echo", "ok"], {
			stdio: "pipe",
		});
		return true;
	} catch {
		return false;
	}
}
const OS_SANDBOX = canRunNestedSandbox();
const skip = OS_SANDBOX
	? false
	: "no functioning macOS sandbox-exec on this host (darwin, /usr/bin/sandbox-exec, and a working, " +
		"non-nested sandbox_apply are all required)";

function policyFixture(overrides: Partial<SandboxPolicy> = {}): SandboxPolicy {
	return {
		mode: "workspace-write",
		allowWrite: [],
		denyWrite: DEFAULT_DENY_WRITE,
		denyRead: [],
		...overrides,
	};
}

// ---- unit tests: no OS sandbox required ----

test("initializeSandboxRuntime rejects with a platform message on a non-darwin host", async () => {
	// The platform is injected as a parameter (see seatbelt.ts's constructor
	// seam) rather than mutated on the global `process` object, so this test
	// runs identically whether the suite itself is on darwin or not.
	await assert.rejects(() => initializeSandboxRuntime(policyFixture(), "linux"), /OS enforcement requires macOS/);
	await assert.rejects(() => initializeSandboxRuntime(policyFixture(), "linux"), /darwin-only/);
	await assert.rejects(() => initializeSandboxRuntime(policyFixture(), "linux"), /platform is linux/);
});

test("lateBoundBashOperations throws the failure reason when there is no runtime and enforcement is expected", async () => {
	const ops = lateBoundBashOperations(
		() => undefined,
		() => "sandbox: bash refused because the runtime could not start",
	);
	await assert.rejects(
		() => ops.exec("echo hi", process.cwd(), { onData: () => {} }),
		/sandbox: bash refused because the runtime could not start/,
	);
});

test("lateBoundBashOperations delegates to the local shell when nothing is enforced", async () => {
	const ops = lateBoundBashOperations(
		() => undefined,
		() => undefined,
	);
	let output = "";
	const { exitCode } = await ops.exec("echo plain", process.cwd(), {
		onData: (data) => {
			output += data.toString();
		},
	});
	assert.equal(exitCode, 0);
	assert.match(output, /plain/);
});

// ---- the real sandbox-exec round trip ----

let fixtureRoot: string;
let work: string;
let outside: string;
let secretExisting: string;
let secretMissing: string;
let runtime: SandboxRuntime | undefined;

before(async () => {
	if (!OS_SANDBOX) return;
	fixtureRoot = mkdtempSync(join(tmpdir(), "seatbelt-rt-"));
	work = join(fixtureRoot, "work");
	outside = join(fixtureRoot, "outside");
	secretExisting = join(work, "existing-secret");
	secretMissing = join(work, "new-secret");
	mkdirSync(work, { recursive: true });
	mkdirSync(outside, { recursive: true });
	mkdirSync(secretExisting, { recursive: true });
	writeFileSync(join(secretExisting, "s.txt"), "top-secret-content");
	writeFileSync(join(work, "visible.txt"), "visible-content");

	const policy = policyFixture({
		allowWrite: [work, "/tmp"],
		denyRead: [secretExisting, secretMissing],
	});
	runtime = await initializeSandboxRuntime(policy);
});

after(async () => {
	await runtime?.reset();
	if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
});

async function run(command: string): Promise<{ exitCode: number | null; output: string }> {
	if (!runtime) throw new Error("runtime not initialized (OS_SANDBOX guard should have skipped this test)");
	const wrapped = await runtime.wrapWithSandbox(command);
	let output = "";
	const { exitCode } = await supervisedSpawn({
		command: wrapped,
		cwd: work,
		onData: (data) => {
			output += data.toString("utf8");
		},
		timeout: 20,
	});
	return { exitCode, output };
}

test("1. echo runs inside the sandbox: the profile loads and the configured shell execs", { skip }, async () => {
	const { exitCode, output } = await run("echo hello-from-seatbelt");
	assert.equal(exitCode, 0);
	assert.match(output, /hello-from-seatbelt/);
});

test("2. a write inside the writable root succeeds", { skip }, async () => {
	const target = join(work, "created.txt");
	const { exitCode, output } = await run(`echo written-ok > ${target} && cat ${target}`);
	assert.equal(exitCode, 0);
	assert.match(output, /written-ok/);
});

test("3. a write outside the writable root is refused", { skip }, async () => {
	const target = join(outside, "nope.txt");
	const { exitCode, output } = await run(`(echo nope > ${target}) 2>&1`);
	assert.notEqual(exitCode, 0);
	assert.match(output, /[Oo]peration not permitted/);
});

test("4. a write to /tmp succeeds (the firmlink-normalization regression test)", { skip }, async () => {
	const target = join("/tmp", `seatbelt-rt-${randomUUID()}`);
	const { exitCode, output } = await run(`echo tmp-ok > ${target} && cat ${target}; rm -f ${target}`);
	assert.equal(exitCode, 0);
	assert.match(output, /tmp-ok/);
});

// Confirmed: this fixture's policy is built by hand at the top of this file
// (`policyFixture({ allowWrite: [work, "/tmp"], denyRead: [...] })`), not
// through `resolveSandboxPolicy`/`toolCacheRoots`, so `/var/tmp` is never
// added to `allowWrite` here. That means this test genuinely exercises the
// vendored process-platform-defaults fragment with its own `/var/tmp` grant
// stripped: it is not passing merely because a real `workspace-write` policy
// (which does add `/var/tmp` via `toolCacheRoots`) would make `/var/tmp`
// writable anyway. If this fixture is ever changed to route through
// `resolveSandboxPolicy`, this case would need `/var/tmp` denied some other
// way, or it would stop proving anything.
test("5. a write to /var/tmp is refused (the stripped process-defaults regression test)", { skip }, async () => {
	const target = join("/var/tmp", `seatbelt-rt-${randomUUID()}`);
	const { exitCode, output } = await run(`(echo nope > ${target}) 2>&1`);
	assert.notEqual(exitCode, 0);
	assert.match(output, /[Oo]peration not permitted/);
});

test("6. cat of a denyRead file is refused; cat of a writable-root file succeeds", { skip }, async () => {
	const denied = await run(`cat ${join(secretExisting, "s.txt")} 2>&1`);
	assert.notEqual(denied.exitCode, 0);
	assert.doesNotMatch(denied.output, /top-secret-content/);

	const allowed = await run(`cat ${join(work, "visible.txt")}`);
	assert.equal(allowed.exitCode, 0);
	assert.match(allowed.output, /visible-content/);
});

test("7. write to a denyWrite glob (.env) is refused even inside the writable root", { skip }, async () => {
	const target = join(work, ".env");
	const { exitCode, output } = await run(`(echo nope > ${target}) 2>&1`);
	assert.notEqual(exitCode, 0);
	assert.match(output, /[Oo]peration not permitted/);
});

test("8. mkdir of a not-yet-existing denyRead name is refused (literal, not just subpath)", { skip }, async () => {
	const { exitCode, output } = await run(`(mkdir ${secretMissing}) 2>&1`);
	assert.notEqual(exitCode, 0);
	assert.match(output, /[Oo]peration not permitted/);
});

test("9. DNS resolution and HTTPS egress both reach the network", { skip }, async (t) => {
	try {
		await dns.lookup("api.github.com");
	} catch {
		t.skip("offline: could not resolve api.github.com outside the sandbox");
		return;
	}
	const { exitCode, output } = await run("curl -sS -o /dev/null -m 15 -w '%{http_code}' https://api.github.com");
	assert.equal(exitCode, 0);
	assert.match(output, /\b[1-5]\d\d\b/);
	assert.doesNotMatch(output, /000/);
});

test("10. loopback bind, connect and inbound traffic work with no extra flag", { skip }, async () => {
	const script = [
		"node -e '",
		'const net = require("net");',
		'const s = net.createServer((c) => { c.on("data", () => { c.end(); s.close(); }); });',
		's.on("error", (e) => { process.stdout.write("listen failed: " + e.message); process.exit(1); });',
		's.listen(0, "127.0.0.1", () => {',
		"  const port = s.address().port;",
		'  const c = net.connect(port, "127.0.0.1", () => c.write("x"));',
		'  c.on("error", (e) => { process.stdout.write("connect failed: " + e.message); process.exit(1); });',
		"});",
		"'",
	].join("\n");
	const { exitCode, output } = await run(script);
	assert.equal(exitCode, 0, output);
});

test("11. a unix domain socket under the writable root works (system-socket covers AF_UNIX)", { skip }, async () => {
	const sockPath = join(work, "seatbelt-rt.sock");
	const script = [
		"node -e '",
		'const net = require("net");',
		'const fs = require("fs");',
		`const sockPath = ${JSON.stringify(sockPath)};`,
		"try { fs.unlinkSync(sockPath); } catch {}",
		"const s = net.createServer((c) => { c.end(); });",
		's.on("error", (e) => { process.stdout.write("listen failed: " + e.message); process.exit(1); });',
		"s.listen(sockPath, () => {",
		'  const c = net.connect(sockPath, () => { c.on("close", () => { s.close(); process.exit(0); }); });',
		'  c.on("error", (e) => { process.stdout.write("connect failed: " + e.message); process.exit(1); });',
		"});",
		"'",
	].join("\n");
	const { exitCode, output } = await run(script);
	assert.equal(exitCode, 0, output);
});

test("12. a malformed profile is rejected at initialize() with sandbox-exec's own stderr", { skip }, async () => {
	const malformed = new SeatbeltSandbox(undefined, "darwin", () => ({
		profile: "(this is not valid SBPL at all",
		params: [],
		warnings: [],
	}));
	await assert.rejects(
		() => malformed.initialize(policyFixture()),
		/sandbox: seatbelt profile rejected by sandbox-exec/,
	);
});
