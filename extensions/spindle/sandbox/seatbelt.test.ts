import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import type { SandboxPolicy } from "./policy.ts";
import { SeatbeltSandbox } from "./seatbelt.ts";

const fixturePolicy: SandboxPolicy = {
	mode: "workspace-write",
	allowWrite: [],
	denyWrite: [],
	denyRead: [],
};

const profileTempDirs = (): Set<string> =>
	new Set(readdirSync(tmpdir()).filter((name) => name.startsWith("pi-spindle-sbx-")));

test("a failure writing the profile file does not leak the temp directory", async () => {
	// This only exercises the pre-write registration order (finding 6): on a
	// host without a real /usr/bin/sandbox-exec (e.g. non-darwin CI), initialize()
	// throws even earlier, before mkdtempSync runs at all, and the before/after
	// snapshots are trivially equal. That is fine: the invariant under test is
	// "no directory this class creates is ever left behind", which holds either way.
	const before = profileTempDirs();
	const sandbox = new SeatbeltSandbox(undefined, "darwin", () => ({
		// writeFileSync throws a TypeError for a non-string/Buffer value, which is
		// what stands in here for any real-world write failure (disk full, EACCES, ...).
		profile: {} as unknown as string,
		params: [],
		warnings: [],
	}));
	await assert.rejects(() => sandbox.initialize(fixturePolicy));
	const after = profileTempDirs();
	for (const name of after) {
		assert.ok(before.has(name), `leaked profile temp dir: ${name}`);
	}
});
