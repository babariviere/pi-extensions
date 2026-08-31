import assert from "node:assert/strict";
import { test } from "node:test";
import { sandboxAskCallback } from "./manager.ts";
import { type PolicyEnvironment, resolveSandboxPolicy } from "./policy.ts";

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
	const policy = resolveSandboxPolicy(
		{ network: { allowedDomains: ["github.com", "*.github.com"] } },
		environment(),
	);
	assert.equal(sandboxAskCallback(policy), undefined);
});
