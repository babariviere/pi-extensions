import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { buildContextManifest, persistContextManifest } from "./context.ts";

test("bounds and atomically persists context manifests", () => {
	const root = mkdtempSync(join(tmpdir(), "background-runtime-context-"));
	try {
		const manifest = buildContextManifest(
			{ attemptId: "attempt", caseId: "case", role: "investigator", context: { evidence: "x".repeat(100000) } },
			{ maxBytes: 4096 },
		);
		const persisted = persistContextManifest(manifest, { attemptDirectory: root });
		assert.ok(persisted.hash.length > 0);
		assert.ok(Buffer.byteLength(readFileSync(persisted.path)) <= 4096);
		assert.equal(statSync(persisted.path).mode & 0o077, 0);
		assert.equal(manifest.truncated, true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
