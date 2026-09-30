import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { execFileTransport } from "./herdr-transport.ts";

/** Install a fake `herdr` on PATH that runs `body` (a /bin/sh snippet). */
function withFakeHerdr<T>(body: string, fn: () => Promise<T>): Promise<T> {
	const dir = mkdtempSync(join(tmpdir(), "fake-herdr-"));
	writeFileSync(join(dir, "herdr"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
	const prevPath = process.env.PATH;
	process.env.PATH = `${dir}:${prevPath ?? ""}`;
	return fn().finally(() => {
		process.env.PATH = prevPath;
	});
}

test("execFileTransport treats a clean exit with empty stdout as success", async () => {
	const res = await withFakeHerdr("exit 0", () => execFileTransport.run(["pane", "run", "wA:p1", "echo hi"]));
	assert.equal(res.ok, true);
	assert.deepEqual(res.result, {});
});

test("execFileTransport reports failure when the command exits non-zero", async () => {
	const res = await withFakeHerdr("echo boom 1>&2; exit 1", () =>
		execFileTransport.run(["pane", "run", "wA:p1", "x"]),
	);
	assert.equal(res.ok, false);
	assert.match(res.error ?? "", /boom/);
});

test("execFileTransport parses JSON stdout on success", async () => {
	const res = await withFakeHerdr(`echo '{"id":"x","result":{"pane_id":"wA:p9"}}'`, () =>
		execFileTransport.run(["pane", "get", "wA:p9"]),
	);
	assert.equal(res.ok, true);
	assert.deepEqual(res.result, { pane_id: "wA:p9" });
});
