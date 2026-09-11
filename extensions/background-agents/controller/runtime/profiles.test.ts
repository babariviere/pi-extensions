import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { normalizeBackgroundAgentsConfig } from "../../config.ts";
import { prepareRuntimeProfile, selectRuntimeProfile } from "./profiles.ts";

test("selects a role-safe isolated profile and stages credentials without returning values", () => {
	const root = mkdtempSync(join(tmpdir(), "background-runtime-profile-"));
	try {
		const source = join(root, "auth.json");
		writeFileSync(source, '{"token":"secret"}');
		chmodSync(source, 0o600);
		const config = normalizeBackgroundAgentsConfig({
			profiles: [{ id: "p", provider: "openai", agentDir: root, authFiles: [source], allowedModels: ["model"] }],
		});
		const selected = selectRuntimeProfile(config, "worker", { attemptDir: join(root, "attempt"), model: "model" });
		const prepared = prepareRuntimeProfile(selected);
		assert.equal(prepared.environment.PI_CODING_AGENT_DIR, join(root, "attempt", "pi-profile"));
		assert.equal(readFileSync(prepared.credentialFiles[0]!, "utf8"), '{"token":"secret"}');
		assert.equal(statSync(prepared.credentialFiles[0]!).mode & 0o077, 0);
		assert.equal(JSON.stringify(prepared).includes("secret"), false);
		assert.throws(
			() => selectRuntimeProfile(config, "investigator", { attemptDir: join(root, "attempt"), tools: ["bash"] }),
			/not tool-capable/,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
