import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { activeNightSandboxRequest } from "./night-bridge.ts";

let dir: string;
let previous: string | undefined;

const writeActiveRun = (run: unknown): void => {
  mkdirSync(join(dir, "night"), { recursive: true });
  writeFileSync(join(dir, "night", "active.json"), JSON.stringify(run));
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "night-bridge-"));
  previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
});

afterEach(() => {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
});

test("no active run means no override", () => {
  assert.equal(activeNightSandboxRequest(), undefined);
});

test("an active run without a sandbox block means no override", () => {
  writeActiveRun({ startedAt: 1, reportPath: "/tmp/r.md", maxPullRequests: 3 });
  assert.equal(activeNightSandboxRequest(), undefined);
});

test("a subagent process picks the policy up from the handshake file", () => {
  writeActiveRun({
    startedAt: 1,
    reportPath: "/tmp/r.md",
    maxPullRequests: 3,
    sandbox: { mode: "workspace-write", allowWrite: ["/sandboxes/repo", ""] },
  });
  assert.deepEqual(activeNightSandboxRequest(), {
    mode: "workspace-write",
    allowWrite: ["/sandboxes/repo"],
  });
});

test("an unknown mode in the handshake is ignored", () => {
  writeActiveRun({
    startedAt: 1,
    reportPath: "/tmp/r.md",
    maxPullRequests: 3,
    sandbox: { mode: "yolo" },
  });
  assert.equal(activeNightSandboxRequest(), undefined);
});
