import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertWriteAllowed,
  DEFAULT_DENY_READ,
  describeSandbox,
  expandPath,
  isEnforcing,
  isInside,
  isSandboxMode,
  isWriteAllowed,
  matchesPattern,
  type PolicyEnvironment,
  resolveSandboxPolicy,
  toolCacheRoots,
  toSandboxRuntimeConfig,
} from "./policy.ts";

const environment = (overrides: Partial<PolicyEnvironment> = {}): PolicyEnvironment => ({
  cwd: "/work/repo",
  home: "/home/dev",
  platform: "linux",
  env: {},
  tmp: "/tmp",
  ...overrides,
});

test("isSandboxMode accepts the four modes and nothing else", () => {
  assert.equal(isSandboxMode("workspace-write"), true);
  assert.equal(isSandboxMode("read-only"), true);
  assert.equal(isSandboxMode("off"), true);
  assert.equal(isSandboxMode("full"), true);
  assert.equal(isSandboxMode("yolo"), false);
  assert.equal(isSandboxMode(undefined), false);
});

test("expandPath handles ~, absolute and relative inputs", () => {
  assert.equal(expandPath("~", "/home/dev", "/work"), "/home/dev");
  assert.equal(expandPath("~/.ssh", "/home/dev", "/work"), "/home/dev/.ssh");
  assert.equal(expandPath("/etc/hosts", "/home/dev", "/work"), "/etc/hosts");
  assert.equal(expandPath("sub/dir", "/home/dev", "/work"), "/work/sub/dir");
  assert.equal(expandPath("  ", "/home/dev", "/work"), "");
});

test("isInside is true for the root itself and descendants only", () => {
  assert.equal(isInside("/work/repo", "/work/repo"), true);
  assert.equal(isInside("/work/repo", "/work/repo/src/a.ts"), true);
  assert.equal(isInside("/work/repo", "/work/repo-2/a.ts"), false);
  assert.equal(isInside("/work/repo", "/home/dev/.zshrc"), false);
});

test("matchesPattern matches basenames, and full paths when the pattern has a slash", () => {
  assert.equal(matchesPattern(".env", "/work/repo/.env"), true);
  assert.equal(matchesPattern(".env.*", "/work/repo/.env.local"), true);
  assert.equal(matchesPattern("*.pem", "/work/repo/certs/key.pem"), true);
  assert.equal(matchesPattern("*.pem", "/work/repo/certs/key.pub"), false);
  assert.equal(matchesPattern("/work/repo/dist/*", "/work/repo/dist/app.js"), true);
  assert.equal(matchesPattern("/work/repo/dist/*", "/work/repo/src/app.js"), false);
});

test("workspace-write grants the run dir plus tool caches", () => {
  const policy = resolveSandboxPolicy({}, environment({ env: { GOCACHE: "/cache/go-build" } }));
  assert.equal(policy.mode, "workspace-write");
  assert.ok(policy.allowWrite.includes("/work/repo"));
  assert.ok(policy.allowWrite.includes("/cache/go-build"));
  assert.ok(policy.allowWrite.includes("/tmp"));
  assert.equal(isWriteAllowed(policy, "/work/repo/src/a.ts"), true);
  assert.equal(isWriteAllowed(policy, "/home/dev/.zshrc"), false);
});

test("read-only grants temp dirs only", () => {
  const policy = resolveSandboxPolicy({ mode: "read-only" }, environment());
  assert.deepEqual(policy.allowWrite, ["/tmp"]);
  assert.equal(isWriteAllowed(policy, "/work/repo/src/a.ts"), false);
  assert.equal(isWriteAllowed(policy, "/tmp/build/out"), true);
});

test("off and full enforce nothing", () => {
  for (const mode of ["off", "full"] as const) {
    const policy = resolveSandboxPolicy({ mode }, environment());
    assert.equal(isEnforcing(policy), false);
    assert.deepEqual(policy.allowWrite, []);
    assert.equal(isWriteAllowed(policy, "/home/dev/.zshrc"), true);
    assert.doesNotThrow(() => assertWriteAllowed(policy, "/home/dev/.zshrc"));
  }
});

test("denyWrite wins over an allowed root", () => {
  const policy = resolveSandboxPolicy({}, environment());
  assert.equal(isWriteAllowed(policy, "/work/repo/.env"), false);
  assert.equal(isWriteAllowed(policy, "/work/repo/certs/server.key"), false);
  assert.equal(isWriteAllowed(policy, "/work/repo/src/a.ts"), true);
});

test("extra allowWrite roots are expanded against home and cwd", () => {
  const policy = resolveSandboxPolicy(
    { allowWrite: ["~/.pi/agent/night", "artifacts"] },
    environment(),
  );
  assert.ok(policy.allowWrite.includes("/home/dev/.pi/agent/night"));
  assert.ok(policy.allowWrite.includes("/work/repo/artifacts"));
});

test("denyRead defaults deny ssh and gnupg but not aws", () => {
  const policy = resolveSandboxPolicy({}, environment());
  assert.deepEqual(policy.denyRead, ["/home/dev/.ssh", "/home/dev/.gnupg"]);
  assert.equal(DEFAULT_DENY_READ.includes("~/.aws"), false);
});

test("toolCacheRoots covers the platform cache home and XDG, not one or the other", () => {
  const darwin = toolCacheRoots(environment({ platform: "darwin" }));
  assert.ok(darwin.includes("/home/dev/Library/Caches"));

  // XDG_CACHE_HOME is additive: Go resolves the cache dir through the OS API
  // and ignores XDG, so dropping the platform path would break builds.
  const xdg = toolCacheRoots(
    environment({ platform: "darwin", env: { XDG_CACHE_HOME: "/xdg/cache" } }),
  );
  assert.ok(xdg.includes("/xdg/cache"));
  assert.ok(xdg.includes("/home/dev/Library/Caches"));
  assert.ok(xdg.includes("/home/dev/go/pkg/mod"));

  const linux = toolCacheRoots(environment({ platform: "linux" }));
  assert.ok(linux.includes("/home/dev/.cache"));
});

test("assertWriteAllowed reports the mode and the writable roots", () => {
  const policy = resolveSandboxPolicy({}, environment());
  assert.throws(
    () => assertWriteAllowed(policy, "/home/dev/.zshrc"),
    /sandbox: write to \/home\/dev\/\.zshrc denied by mode 'workspace-write'\. Writable roots: \/work\/repo/,
  );
});

test("toSandboxRuntimeConfig mirrors the policy", () => {
  const policy = resolveSandboxPolicy({ network: { allowedDomains: ["github.com"] } }, environment());
  const config = toSandboxRuntimeConfig(policy);
  assert.deepEqual(config.network, { allowedDomains: ["github.com"], deniedDomains: [] });
  assert.deepEqual(config.filesystem.denyRead, ["/home/dev/.ssh", "/home/dev/.gnupg"]);
  assert.ok(config.filesystem.allowWrite.includes("/work/repo"));
});

test("describeSandbox summarises enforcement", () => {
  assert.match(describeSandbox(resolveSandboxPolicy({}, environment())), /^sandbox workspace-write: /);
  assert.match(
    describeSandbox(resolveSandboxPolicy({ mode: "off" }, environment())),
    /no enforcement/,
  );
});
