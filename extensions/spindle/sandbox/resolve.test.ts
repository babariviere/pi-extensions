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
	assert.equal(effectiveSandbox({ settings: settings("off"), requested: { mode: "read-only" } }).mode, "read-only");
	assert.equal(effectiveSandbox({ settings: settings("read-only"), requested: { mode: "off" } }).mode, "off");
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

test("a narrowed allowlist is widened by the night run's domains", () => {
	const effective = effectiveSandbox({
		settings: { ...settings("workspace-write"), allowedDomains: ["registry.npmjs.org"] },
		night: { mode: "workspace-write", network: { allowedDomains: ["github.com", "registry.npmjs.org"] } },
	});
	assert.deepEqual(effective.network.allowedDomains, ["registry.npmjs.org", "github.com"]);
});

test("an unrestricted allowlist still keeps the night's concrete domains", () => {
	// `*` never reaches srt, so a caller allowlist dropped here becomes an empty
	// allowlist at the runtime, which denies every socket instead of allowing all.
	const effective = effectiveSandbox({
		settings: settings("workspace-write"),
		night: { mode: "workspace-write", network: { allowedDomains: ["github.com", "*.github.com"] } },
	});
	assert.deepEqual(effective.network.allowedDomains, ["*", "github.com", "*.github.com"]);
});

test("merging the night's domains never duplicates one the settings already name", () => {
	const effective = effectiveSandbox({
		settings: { ...settings("workspace-write"), allowedDomains: ["*", "github.com"] },
		night: { mode: "workspace-write", network: { allowedDomains: ["github.com"] } },
	});
	assert.deepEqual(effective.network.allowedDomains, ["*", "github.com"]);
});

test("a request cannot widen the allowlist, only a night run can", () => {
	const effective = effectiveSandbox({
		settings: { ...settings("workspace-write"), allowedDomains: ["registry.npmjs.org"] },
		requested: { mode: "workspace-write", network: { allowedDomains: ["evil.example"] } },
	});
	assert.deepEqual(effective.network.allowedDomains, ["registry.npmjs.org"]);
});

test("denied domains stay config-only, so the kill switch survives", () => {
	const effective = effectiveSandbox({
		settings: { ...settings("workspace-write"), allowedDomains: [], deniedDomains: ["github.com"] },
		night: { mode: "workspace-write", network: { allowedDomains: ["github.com"] } },
	});
	assert.deepEqual(effective.network.deniedDomains, ["github.com"]);
});

test("an agent definition floors the mode: a subagent cannot loosen it", () => {
	const effective = effectiveSandbox({
		settings: settings("off"),
		requested: { mode: "off" },
		agent: { mode: "read-only" },
	});
	assert.equal(effective.mode, "read-only");
	assert.equal(effective.source, "agent");
	assert.deepEqual(effective.refused, { asked: "off", enforced: "read-only" });
});

test("a request may tighten past the agent floor", () => {
	const effective = effectiveSandbox({
		settings: settings("off"),
		requested: { mode: "read-only" },
		agent: { mode: "workspace-write" },
	});
	assert.equal(effective.mode, "read-only");
	assert.equal(effective.source, "request");
	assert.equal(effective.refused, undefined);
});

test("the tightest of the night and agent floors wins", () => {
	const nightTighter = effectiveSandbox({
		settings: settings("off"),
		night: { mode: "read-only" },
		agent: { mode: "workspace-write" },
	});
	assert.equal(nightTighter.mode, "read-only");
	assert.equal(nightTighter.source, "night");

	const agentTighter = effectiveSandbox({
		settings: settings("off"),
		night: { mode: "workspace-write", allowWrite: ["/sandboxes/run"] },
		agent: { mode: "read-only" },
	});
	assert.equal(agentTighter.mode, "read-only");
	assert.equal(agentTighter.source, "agent");
	// The night's roots survive a tightening floor, so its report stays writable.
	assert.ok(agentTighter.allowWrite.includes("/sandboxes/run"));
});

test("an agent floor with extra roots keeps them writable", () => {
	const effective = effectiveSandbox({
		settings: settings("off"),
		agent: { mode: "read-only", allowWrite: ["/runs/artifacts"] },
	});
	assert.equal(effective.mode, "read-only");
	assert.deepEqual(effective.allowWrite, ["/runs/artifacts"]);
});

test("config can enable loopback without a night run", () => {
	const effective = effectiveSandbox({ settings: { ...settings("workspace-write"), allowLoopback: true } });
	assert.equal(effective.network.allowLoopback, true);
});

test("a night run can enable loopback for a config that leaves it off", () => {
	const effective = effectiveSandbox({
		settings: settings("off"),
		night: { mode: "workspace-write", network: { allowLoopback: true } },
	});
	assert.equal(effective.network.allowLoopback, true);
});

test("loopback stays off when neither config nor night asks for it", () => {
	assert.equal(effectiveSandbox({ settings: settings("workspace-write") }).network.allowLoopback, false);
});
