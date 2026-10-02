import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { normalizeClefConfig } from "./config.ts";
import { ClefSetup } from "./setup.ts";

const fixture = fileURLToPath(new URL("./fixtures/setup.mjs", import.meta.url));
const makeSetup = (args: string[] = [], timeoutMs = 5000) =>
	new ClefSetup(normalizeClefConfig({}), { executable: process.execPath, args: [fixture, ...args] }, timeoutMs);

test("preparation is lazy, shared, cached, and online even in an offline host", async (t) => {
	const previous = {
		HF_HUB_OFFLINE: process.env.HF_HUB_OFFLINE,
		TRANSFORMERS_OFFLINE: process.env.TRANSFORMERS_OFFLINE,
	};
	process.env.HF_HUB_OFFLINE = "1";
	process.env.TRANSFORMERS_OFFLINE = "1";
	t.after(() => {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
	const setup = makeSetup(["delay", "40"]);
	t.after(() => setup.unload());
	assert.equal(setup.status, "not prepared");
	const first = setup.prepare();
	assert.equal(setup.prepare(), first);
	assert.match(setup.status, /preparing/);
	const ready = await first;
	assert.equal(ready.python, process.execPath);
	assert.equal(setup.status, "prepared");
	await setup.unload();
	assert.deepEqual(await setup.prepare(), ready, "unloading does not delete installed packages or weights");
});

test("setup failures are actionable and retryable", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "clef-setup-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const setup = makeSetup(["retry", join(dir, "attempt")]);
	t.after(() => setup.unload());
	await assert.rejects(setup.prepare(), /Checkpoint download failed/);
	assert.match(setup.status, /setup failed/);
	assert.equal((await setup.prepare()).python, process.execPath);
	assert.equal(setup.status, "prepared");
});

test("bad responses and missing Python fail without leaking arbitrary output", async (t) => {
	for (const mode of ["malformed", "oversize", "relative"]) {
		const setup = makeSetup([mode]);
		t.after(() => setup.unload());
		await assert.rejects(setup.prepare(), /invalid response|oversized response/);
	}
	const setup = new ClefSetup(normalizeClefConfig({}), { executable: "/no-such-python", args: [] });
	t.after(() => setup.unload());
	await assert.rejects(setup.prepare(), /Install Python 3.11/);
});

test("setup timeout is bounded", async (t) => {
	const setup = makeSetup(["delay", "1000"], 30);
	t.after(() => setup.unload());
	await assert.rejects(setup.prepare(), /setup timed out/);
});

test("unloading preparation terminates its subprocess group and settles waiters", async (t) => {
	if (process.platform === "win32") return t.skip("MLX requires macOS; process groups are Unix-only");
	const dir = mkdtempSync(join(tmpdir(), "clef-setup-kill-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const marker = join(dir, "pids");
	const setup = makeSetup(["hang", marker]);
	t.after(() => setup.unload());
	const rejected = assert.rejects(setup.prepare(), /cancelled/);
	for (let i = 0; i < 300 && !existsSync(marker); i++) await sleep(10);
	const pids = JSON.parse(readFileSync(marker, "utf8"));
	await setup.unload();
	await rejected;
	for (const pid of Object.values(pids) as number[]) {
		for (let i = 0; i < 300; i++) {
			try {
				process.kill(pid, 0);
			} catch {
				break;
			}
			await sleep(10);
		}
		assert.throws(() => process.kill(pid, 0));
	}
	await setup.unload();
});

test("unresponsive preparation is force-killed", async (t) => {
	if (process.platform === "win32") return t.skip("process groups are Unix-only");
	const dir = mkdtempSync(join(tmpdir(), "clef-setup-force-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const marker = join(dir, "pids");
	const setup = makeSetup(["ignoreTerm", marker]);
	t.after(() => setup.unload());
	const rejected = assert.rejects(setup.prepare(), /cancelled/);
	for (let i = 0; i < 300 && !existsSync(marker); i++) await sleep(10);
	const { parent } = JSON.parse(readFileSync(marker, "utf8"));
	await setup.unload();
	await rejected;
	assert.throws(() => process.kill(parent, 0));
});
