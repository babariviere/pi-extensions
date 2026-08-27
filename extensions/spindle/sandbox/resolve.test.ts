import assert from "node:assert/strict";
import { test } from "node:test";
import { modeRestrictiveness, tighterMode } from "./policy.ts";
import { effectiveSandbox, type SandboxSettings } from "./resolve.ts";

const settings = (mode: SandboxSettings["mode"] = "off"): SandboxSettings => ({
  mode,
  allowWrite: [],
  denyWrite: [],
  denyRead: [],
  allowedDomains: ["*"],
  deniedDomains: [],
});

test("read-only is tighter than workspace-write, which is tighter than off or full", () => {
  assert.ok(modeRestrictiveness("read-only") > modeRestrictiveness("workspace-write"));
  assert.ok(modeRestrictiveness("workspace-write") > modeRestrictiveness("off"));
  assert.equal(modeRestrictiveness("full"), modeRestrictiveness("off"));
  assert.equal(tighterMode("off", "read-only"), "read-only");
  assert.equal(tighterMode("read-only", "workspace-write"), "read-only");
});

test("with no request and no night run, config wins", () => {
  const effective = effectiveSandbox({ settings: settings("off") });
  assert.equal(effective.mode, "off");
  assert.equal(effective.source, "config");
  assert.equal(effective.refused, undefined);
});

test("a request overrides config in both directions", () => {
  assert.equal(
    effectiveSandbox({ settings: settings("off"), requested: { mode: "read-only" } }).mode,
    "read-only",
  );
  assert.equal(
    effectiveSandbox({ settings: settings("read-only"), requested: { mode: "off" } }).mode,
    "off",
  );
});

test("a night run floors the mode: loosening is refused", () => {
  const effective = effectiveSandbox({
    settings: settings("off"),
    requested: { mode: "off" },
    night: { mode: "workspace-write", allowWrite: ["/sandboxes/run"] },
  });
  assert.equal(effective.mode, "workspace-write");
  assert.equal(effective.source, "night");
  assert.deepEqual(effective.refused, { asked: "off", enforced: "workspace-write" });
});

test("`full` cannot escape a night run either", () => {
  const effective = effectiveSandbox({
    settings: settings("off"),
    requested: { mode: "full" },
    night: { mode: "workspace-write" },
  });
  assert.equal(effective.mode, "workspace-write");
  assert.deepEqual(effective.refused, { asked: "full", enforced: "workspace-write" });
});

test("tightening during a night run is allowed", () => {
  const effective = effectiveSandbox({
    settings: settings("off"),
    requested: { mode: "read-only" },
    night: { mode: "workspace-write" },
  });
  assert.equal(effective.mode, "read-only");
  assert.equal(effective.source, "request");
  assert.equal(effective.refused, undefined);
});

test("the night's writable roots survive a tightening request", () => {
  const effective = effectiveSandbox({
    settings: { ...settings("off"), allowWrite: ["~/base"] },
    requested: { mode: "read-only", allowWrite: ["/extra"] },
    night: { mode: "workspace-write", allowWrite: ["/sandboxes/run", "/reports"] },
  });
  assert.deepEqual(effective.allowWrite, ["~/base", "/sandboxes/run", "/reports", "/extra"]);
});

test("a night run with no request still applies its own floor", () => {
  const effective = effectiveSandbox({
    settings: settings("off"),
    night: { mode: "workspace-write", allowWrite: ["/sandboxes/run"] },
  });
  assert.equal(effective.mode, "workspace-write");
  assert.equal(effective.source, "night");
  assert.deepEqual(effective.allowWrite, ["/sandboxes/run"]);
});
