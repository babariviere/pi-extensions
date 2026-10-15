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
	const policy = { version: 1, windows: [window], forced: [] as string[] };
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
	await writeFile(other, JSON.stringify({ ...policy, forced: [JSON.stringify(["openai", "5h", window.resetsAt])] }));
	await new SubscriptionGate(other).wait("openai-codex");
	assert.equal(admitted, 0);
	policy.forced = [JSON.stringify(["openai", "5h", window.resetsAt])];
	await save();
	await Promise.all([a, b]);
	assert.equal(admitted, 2);
	policy.forced = [];
	window.resetsAt = new Date(Date.now() - 1).toISOString();
	await save();
	await parent.wait("openai-codex");
});

test("configured missing/malformed policies hold safely and Stop cancels the wait", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "subscription-gate-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	for (const content of [undefined, "{broken", JSON.stringify({ version: 1 })]) {
		const path = join(dir, "policy.json");
		if (content) await writeFile(path, content);
		const abort = new AbortController();
		const waiting = new SubscriptionGate(path, 5).wait("anthropic", abort.signal);
		abort.abort();
		await assert.rejects(waiting, { name: "AbortError" });
	}
	await new SubscriptionGate("").wait("anthropic");
});
