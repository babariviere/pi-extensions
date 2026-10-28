import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SubscriptionGate } from "./subscription-gate.mjs";

test("per-chat policy gates parent/children by provider, resets and force scope", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "subscription-gate-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "policy.json");
	const window = { provider: "openai", label: "5h", resetsAt: new Date(Date.now() + 60_000).toISOString() };
	type Window = { provider: string; label: string; resetsAt?: string };
	const policy: { version: number; windows: Window[]; force?: string[] } = { version: 1, windows: [window] };
	const save = () => writeFile(path, JSON.stringify(policy));
	await save();
	const parent = new SubscriptionGate(path, 5),
		child = new SubscriptionGate(path, 5);
	await parent.wait("anthropic");
	await parent.wait("openai"); // API-key provider is not a subscription account.
	const abort = new AbortController();
	let admitted = 0;
	const a = parent.wait("openai-codex", abort.signal).then(() => admitted++);
	const b = child.wait("openai-codex", abort.signal).then(() => admitted++);
	t.after(() => abort.abort());
	// A different chat's force must not thaw this chat.
	const other = join(dir, "other.json");
	await writeFile(other, JSON.stringify({ ...policy, force: ["openai"] }));
	await new SubscriptionGate(other).wait("openai-codex");
	assert.equal(admitted, 0);
	policy.force = ["anthropic"];
	await save();
	await parent.wait("anthropic");
	assert.equal(admitted, 0, "force is scoped to its provider");
	policy.force = ["openai"];
	await save();
	await Promise.all([a, b]);
	assert.equal(admitted, 2);
	window.resetsAt = new Date(Date.now() + 120_000).toISOString();
	policy.windows.push({ provider: "openai", label: "Week" });
	await save();
	await parent.wait("openai-codex"); // Force covers moved and new windows.
	delete policy.force;
	policy.windows.pop();
	window.resetsAt = new Date(Date.now() - 1).toISOString();
	await save();
	await parent.wait("openai-codex");
});

test("configured missing/malformed policies hold safely and Stop cancels the wait", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "subscription-gate-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	for (const content of [
		undefined,
		"{broken",
		JSON.stringify({ version: 1 }),
		JSON.stringify({ version: 1, windows: [], force: ["other"] }),
	]) {
		const path = join(dir, "policy.json");
		if (content) await writeFile(path, content);
		const abort = new AbortController();
		const waiting = new SubscriptionGate(path, 5).wait("anthropic", abort.signal);
		abort.abort();
		await assert.rejects(waiting, { name: "AbortError" });
	}
	await new SubscriptionGate("").wait("anthropic");
});
